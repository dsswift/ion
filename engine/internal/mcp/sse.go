package mcp

// sse.go — the SSE (Server-Sent Events) MCP transport.
//
// Split out of mcp.go, which sits against the 800-line cap: stdio stays with the
// core client, and each network transport owns its own file (http.go, ws.go, and
// now this one).
//
// SSE is the older MCP network transport; new remote servers should use
// StreamableHTTP (http.go). It is kept because servers speaking only SSE exist.
// Its shape differs from http in one way that matters for credentials: the
// server-to-client channel is a single long-lived GET, so the token on that
// stream is whatever was current when the stream opened. Only the client-to-server
// message POST re-resolves per request.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// --- SSE transport ---

type sseTransport struct {
	baseURL   string
	headers   map[string]string
	msgCh     chan json.RawMessage
	client    *http.Client
	done      chan struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup
	// userToken mirrors httpTransport.userToken: per-request operator
	// bearer resolution when config.forwardUserToken is set. Each message
	// POST re-resolves so a long-lived stream doesn't pin an expiring
	// token on the send path; the stream GET carries the token minted at
	// stream open.
	userToken func() (string, error)
	// oauth mirrors httpTransport.oauth: per-request resolution of this
	// server's own OAuth token, refreshing when it has expired. The message
	// POST re-resolves so a stream open for longer than the token's lifetime
	// keeps sending a usable credential. The stream GET carries whatever was
	// current when the stream opened -- refreshing that requires reopening the
	// stream, which is why the http transport is preferable for an OAuth server.
	oauth *tokenResolver
	// serverName is carried for log correlation on the stream goroutine.
	serverName string
}

func newSSETransport(serverName string, config types.McpServerConfig, headers map[string]string, userToken func() (string, error)) (*sseTransport, error) {
	if config.URL == "" {
		return nil, fmt.Errorf("SSE transport requires URL")
	}

	t := &sseTransport{
		baseURL:    strings.TrimRight(config.URL, "/"),
		headers:    headers,
		msgCh:      make(chan json.RawMessage, 64),
		client:     &http.Client{},
		done:       make(chan struct{}),
		userToken:  userToken,
		serverName: serverName,
	}

	// Start SSE event stream reader goroutine.
	t.wg.Add(1)
	go t.readEventStream()

	return t, nil
}

// applyHeaders stamps the configured static headers and, when forwarding
// is configured, the operator bearer token (which wins over any static
// Authorization value).
func (t *sseTransport) applyHeaders(req *http.Request) error {
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	// This server's OAuth token, refreshed on expiry. Applied before the
	// operator token so forwardUserToken remains the explicit override.
	if t.oauth != nil {
		value, err := t.oauth.Token()
		if err != nil {
			// Proceed unauthenticated: the server's 401 carries the connect-path
			// remediation, which is more actionable than a refresh error here.
			utils.LogWithFields(utils.LevelError, "mcp.sse", "oauth token unavailable; sending request without authorization", map[string]any{
				"serverName": t.serverName, "error": err.Error(),
			})
		} else {
			req.Header.Set("Authorization", value)
		}
	}
	if t.userToken != nil {
		token, err := t.userToken()
		if err != nil {
			return fmt.Errorf("resolve operator token: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return nil
}

// readEventStream connects to the SSE endpoint and reads events into msgCh.
func (t *sseTransport) readEventStream() {
	defer t.wg.Done()

	req, err := http.NewRequest(http.MethodGet, t.baseURL, nil)
	if err != nil {
		return
	}
	req.Header.Set("Accept", "text/event-stream")
	if err := t.applyHeaders(req); err != nil {
		utils.LogWithFields(utils.LevelError, "mcp.sse", "event stream header resolution failed", map[string]any{"serverName": t.serverName, "error": err.Error()})
		return
	}

	resp, err := t.client.Do(req)
	if err != nil {
		// Connect failure: the goroutine exits, msgCh is never fed, and every
		// tool on this server becomes unresolvable. Log so this is not silent.
		utils.LogWithFields(utils.LevelError, "mcp.sse", "event stream connect failed", map[string]any{"serverName": t.serverName, "url": t.baseURL, "error": err.Error()})
		return
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // resource close

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// A non-2xx status (401/403/500) returns a body with no `data:` lines;
		// without this check an auth rejection looks like a healthy empty
		// stream and downstream sees only a timeout.
		utils.LogWithFields(utils.LevelError, "mcp.sse", "event stream non-2xx status", map[string]any{"serverName": t.serverName, "url": t.baseURL, "status": resp.StatusCode})
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		select {
		case <-t.done:
			return
		default:
		}

		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		data = strings.TrimSpace(data)
		if len(data) == 0 || !json.Valid([]byte(data)) {
			continue
		}

		select {
		case t.msgCh <- json.RawMessage(data):
		case <-t.done:
			return
		}
	}
}

func (t *sseTransport) Send(msg json.RawMessage) error {
	select {
	case <-t.done:
		return fmt.Errorf("SSE transport closed")
	default:
	}

	req, err := http.NewRequest(http.MethodPost, t.baseURL+"/message", strings.NewReader(string(msg)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if err := t.applyHeaders(req); err != nil {
		return err
	}

	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // resource close

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body) //nolint:errcheck // best-effort read of error-response body
		return fmt.Errorf("SSE send error (status %d): %s", resp.StatusCode, string(body))
	}

	// Some MCP servers return inline JSON-RPC responses in the POST body
	// rather than via the event stream. Queue them like stream events.
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil // Send succeeded; read failure is non-fatal.
	}
	if len(body) > 0 && json.Valid(body) {
		select {
		case t.msgCh <- json.RawMessage(body):
		case <-t.done:
		}
	}

	return nil
}

func (t *sseTransport) Receive() (json.RawMessage, error) {
	msg, ok := <-t.msgCh
	if !ok {
		return nil, io.EOF
	}
	return msg, nil
}

func (t *sseTransport) Close() error {
	t.closeOnce.Do(func() {
		close(t.done)
		// Wait for the reader goroutine to exit before closing msgCh
		// to prevent send-on-closed-channel panic.
		t.wg.Wait()
		close(t.msgCh)
	})
	return nil
}
