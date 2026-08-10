package mcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/utils"
)

// httpTransport implements mcpTransport for StreamableHTTP MCP servers.
type httpTransport struct {
	baseURL   string
	headers   map[string]string
	client    *http.Client
	sessionID string
	mu        sync.Mutex
	respCh    chan json.RawMessage
	closed    atomic.Bool
	closeOnce sync.Once
	// userToken, when non-nil, resolves the configured identity's bearer
	// token (config.forwardUserToken). Resolved on EVERY request -- the
	// connection is long-lived, so a connect-time token would expire
	// mid-session; per-request resolution rides the identity manager's
	// cache + silent refresh instead.
	userToken func() (string, error)
	// oauth, when non-nil, resolves this server's own OAuth token per request
	// for the same reason userToken is resolved per request: an MCP connection
	// routinely outlives its access token (Mobbin's last an hour), so a header
	// baked in at connect time turns every later tool call into a 401 with the
	// stored refresh token going unused. It also drives the one-shot retry on a
	// rejection, for a token the provider revoked before its stated expiry.
	oauth *tokenResolver
}

func newHTTPTransport(baseURL string, headers map[string]string, userToken func() (string, error)) (*httpTransport, error) {
	if baseURL == "" {
		return nil, fmt.Errorf("HTTP transport requires base URL")
	}
	return &httpTransport{
		baseURL:   baseURL,
		headers:   headers,
		client:    &http.Client{},
		respCh:    make(chan json.RawMessage, 64),
		userToken: userToken,
	}, nil
}

// applyOAuthToken stamps this server's OAuth bearer token, refreshing it first
// when it has expired. Applied after the static headers so a freshly-refreshed
// token wins over the value captured at connect time.
//
// A resolution failure is logged and the request proceeds without the header:
// the server's 401 then carries the connect-path remediation, which tells the
// operator what to run. Aborting the request instead would surface a refresh
// error in place of that guidance.
func (t *httpTransport) applyOAuthToken(req *http.Request) {
	if t.oauth == nil {
		return
	}
	value, err := t.oauth.Token()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "mcp.http", "oauth token unavailable; sending request without authorization", map[string]any{
			"url": t.baseURL, "error": err.Error(),
		})
		return
	}
	req.Header.Set("Authorization", value)
}

// applyUserToken stamps the operator bearer token when forwarding is
// configured. Applied after static headers so the freshly-minted token
// wins over any stale static Authorization value.
func (t *httpTransport) applyUserToken(req *http.Request) error {
	if t.userToken == nil {
		return nil
	}
	token, err := t.userToken()
	if err != nil {
		return fmt.Errorf("resolve identity token: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return nil
}

func (t *httpTransport) Send(msg json.RawMessage) error {
	status, body, contentType, sentAuth, err := t.doRequest(msg)
	if err != nil {
		return err
	}

	// One-shot retry on an authorization rejection.
	//
	// The stored token can be refused while the engine still believes it is
	// valid: the provider revoked or rotated it, or the clocks disagree. The
	// expiry-driven refresh in applyOAuthToken cannot see that, so without this
	// the connection stays wedged on a dead credential until the session is
	// restarted. Retried exactly once — a second 401 after a successful refresh
	// means the grant itself is no longer good, and looping would hammer the
	// provider's token endpoint.
	if isHTTPAuthRejection(status) && t.oauth != nil && t.oauth.HasCredentials() {
		utils.LogWithFields(utils.LevelWarn, "mcp.http", "request rejected as unauthorized; refreshing token and retrying once", map[string]any{
			"url": t.baseURL, "status": status,
		})
		if _, refreshErr := t.oauth.ForceRefresh(sentAuth); refreshErr != nil {
			utils.LogWithFields(utils.LevelError, "mcp.http", "token refresh after rejection failed", map[string]any{
				"url": t.baseURL, "error": refreshErr.Error(),
			})
			return fmt.Errorf("HTTP error (status %d, bodyBytes=%d)", status, len(body))
		}
		status, body, contentType, _, err = t.doRequest(msg)
		if err != nil {
			return err
		}
		if isHTTPAuthRejection(status) {
			utils.LogWithFields(utils.LevelError, "mcp.http", "still unauthorized after a successful token refresh; the grant is no longer valid", map[string]any{
				"url": t.baseURL, "status": status,
			})
		}
	}

	if status >= 400 {
		return fmt.Errorf("HTTP error (status %d, bodyBytes=%d)", status, len(body))
	}

	// A StreamableHTTP server answers with EITHER a bare JSON object or an SSE
	// stream, its choice per request — which is why the Accept header advertises
	// both. Handling only raw JSON meant an SSE-framed reply failed json.Valid
	// and was silently discarded, so the caller waited on a response that had
	// already arrived and the call died at its timeout with no diagnostic.
	// api.mobbin.com replies this way for every request.
	frames := decodeHTTPResponseFrames(contentType, body)
	if len(frames) == 0 && len(body) > 0 {
		// Undecodable non-empty body: log it rather than dropping the response,
		// which would present as an unexplained timeout.
		utils.LogWithFields(utils.LevelWarn, "mcp.http", "response body carried no decodable JSON-RPC frame", map[string]any{
			"contentType": contentType,
			"bodyBytes":   len(body),
		})
	}
	for _, frame := range frames {
		if t.closed.Load() {
			break
		}
		t.respCh <- frame
	}

	return nil
}

// doRequest performs one POST of msg and returns the status, body, and
// Content-Type. Split out of Send so the authorization retry can replay the
// identical request after refreshing the token — msg is re-read from the caller's
// buffer each time rather than from a consumed reader.
func (t *httpTransport) doRequest(msg json.RawMessage) (status int, body []byte, contentType string, sentAuth string, err error) {
	req, err := http.NewRequest(http.MethodPost, t.baseURL, bytes.NewReader(msg))
	if err != nil {
		return 0, nil, "", "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	// StreamableHTTP requires BOTH media types: the server chooses per request
	// whether to answer with a single JSON object or an SSE stream, so a client
	// advertising only one is non-conformant. Servers that enforce this reject
	// the request outright — api.mobbin.com answers 406 "Client must accept both
	// application/json and text/event-stream" — which strands every tool on the
	// server behind a failed initialize.
	req.Header.Set("Accept", "application/json, text/event-stream")

	t.mu.Lock()
	if t.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", t.sessionID)
	}
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	t.mu.Unlock()

	// Per-request token resolution. Order matters: the OAuth token is applied
	// after the static headers so a refreshed value replaces the one captured at
	// connect, and the explicitly forwarded identity token last as the
	// opt-in override.
	t.applyOAuthToken(req)
	if tokenErr := t.applyUserToken(req); tokenErr != nil {
		return 0, nil, "", "", tokenErr
	}
	sentAuth = req.Header.Get("Authorization")

	resp, err := t.client.Do(req)
	if err != nil {
		return 0, nil, "", "", fmt.Errorf("http send: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp.http", "response body close failed", map[string]any{"error": closeErr.Error()})
		}
	}()

	// Capture session ID from response.
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		t.mu.Lock()
		t.sessionID = sid
		t.mu.Unlock()
	}

	body, err = io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, "", "", fmt.Errorf("read response: %w", err)
	}
	return resp.StatusCode, body, resp.Header.Get("Content-Type"), sentAuth, nil
}

// isHTTPAuthRejection reports whether a status means "your credential was not
// accepted". 403 is included alongside 401: an insufficient-scope rejection is
// also resolved by presenting a fresh token.
func isHTTPAuthRejection(status int) bool {
	return status == http.StatusUnauthorized || status == http.StatusForbidden
}

// decodeHTTPResponseFrames extracts JSON-RPC frames from a StreamableHTTP
// response body, accepting both shapes the transport can receive:
//
//   - a bare JSON object (Content-Type: application/json)
//   - an SSE stream (Content-Type: text/event-stream), whose `data:` lines each
//     carry one frame
//
// The Content-Type is a hint, not a gate: some servers return SSE framing under
// a generic or absent content type, so a body that looks like an event stream is
// parsed as one regardless of what the header claims.
func decodeHTTPResponseFrames(contentType string, body []byte) []json.RawMessage {
	if len(body) == 0 {
		return nil
	}

	// Fast path: a plain JSON body.
	if json.Valid(body) {
		return []json.RawMessage{json.RawMessage(body)}
	}

	isEventStream := strings.Contains(strings.ToLower(contentType), "text/event-stream") ||
		bytes.Contains(body, []byte("data:"))
	if !isEventStream {
		return nil
	}

	var frames []json.RawMessage
	scanner := bufio.NewScanner(bytes.NewReader(body))
	// SSE data lines can carry a full JSON-RPC payload, which for a tools/list
	// on a large server exceeds the default 64 KB token limit.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Only `data:` carries payload; `event:`, `id:`, `retry:`, comments
		// (`:`), and blank separators are framing.
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || !json.Valid([]byte(payload)) {
			continue
		}
		frames = append(frames, json.RawMessage(payload))
	}
	return frames
}

func (t *httpTransport) Receive() (json.RawMessage, error) {
	msg, ok := <-t.respCh
	if !ok {
		return nil, io.EOF
	}
	return msg, nil
}

func (t *httpTransport) Close() error {
	t.closeOnce.Do(func() {
		t.closed.Store(true)

		t.mu.Lock()
		sid := t.sessionID
		t.mu.Unlock()

		if sid != "" {
			req, err := http.NewRequest(http.MethodDelete, t.baseURL, nil)
			if err == nil {
				req.Header.Set("Mcp-Session-Id", sid)
				for k, v := range t.headers {
					req.Header.Set(k, v)
				}
				if tokenErr := t.applyUserToken(req); tokenErr != nil {
					// Best-effort session cleanup: log and send without the
					// token rather than leaking the server-side session.
					utils.LogWithFields(utils.LevelInfo, "mcp.http", "identity token unavailable for session delete", map[string]any{"error": tokenErr.Error()})
				}
				resp, err := t.client.Do(req)
				if err == nil {
					resp.Body.Close() //nolint:errcheck // resource close
				}
			}
		}

		close(t.respCh)
	})
	return nil
}
