package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
)

// httpTransport implements mcpTransport for StreamableHTTP MCP servers.
type httpTransport struct {
	baseURL   string
	headers   map[string]string
	client    *http.Client
	sessionID string
	mu        sync.Mutex
	respCh    chan json.RawMessage
}

func newHTTPTransport(baseURL string, headers map[string]string) (*httpTransport, error) {
	if baseURL == "" {
		return nil, fmt.Errorf("HTTP transport requires base URL")
	}
	return &httpTransport{
		baseURL: baseURL,
		headers: headers,
		client:  &http.Client{},
		respCh:  make(chan json.RawMessage, 64),
	}, nil
}

func (t *httpTransport) Send(msg json.RawMessage) error {
	req, err := http.NewRequest(http.MethodPost, t.baseURL, bytes.NewReader(msg))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	t.mu.Lock()
	if t.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", t.sessionID)
	}
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	t.mu.Unlock()

	resp, err := t.client.Do(req)
	if err != nil {
		return fmt.Errorf("http send: %w", err)
	}
	defer resp.Body.Close()

	// Capture session ID from response.
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		t.mu.Lock()
		t.sessionID = sid
		t.mu.Unlock()
	}

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP error (status %d): %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	if len(body) > 0 && json.Valid(body) {
		t.respCh <- json.RawMessage(body)
	}

	return nil
}

func (t *httpTransport) Receive() (json.RawMessage, error) {
	msg, ok := <-t.respCh
	if !ok {
		return nil, io.EOF
	}
	return msg, nil
}

func (t *httpTransport) Close() error {
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
			resp, err := t.client.Do(req)
			if err == nil {
				resp.Body.Close()
			}
		}
	}

	close(t.respCh)
	return nil
}
