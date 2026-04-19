package mcp

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// mockTransport implements mcpTransport for testing.
type mockTransport struct {
	sent     []json.RawMessage
	recvMsgs []json.RawMessage
	recvIdx  int
	closed   bool
}

func (m *mockTransport) Send(msg json.RawMessage) error {
	m.sent = append(m.sent, msg)
	return nil
}

func (m *mockTransport) Receive() (json.RawMessage, error) {
	if m.recvIdx >= len(m.recvMsgs) {
		return nil, json.Unmarshal([]byte("{}"), nil) // Force error
	}
	msg := m.recvMsgs[m.recvIdx]
	m.recvIdx++
	return msg, nil
}

func (m *mockTransport) Close() error {
	m.closed = true
	return nil
}

func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func TestToolDef_Fields(t *testing.T) {
	td := ToolDef{
		Name:        "bash",
		Description: "Run shell commands",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string"},
			},
		},
	}

	if td.Name != "bash" {
		t.Errorf("expected bash, got %q", td.Name)
	}
	if td.Description != "Run shell commands" {
		t.Errorf("wrong description")
	}
}

func TestConnection_Tools(t *testing.T) {
	conn := &Connection{
		name: "test",
		tools: []ToolDef{
			{Name: "tool1", Description: "First tool"},
			{Name: "tool2", Description: "Second tool"},
		},
	}

	tools := conn.Tools()
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(tools))
	}
	if tools[0].Name != "tool1" {
		t.Errorf("expected tool1, got %q", tools[0].Name)
	}
}

func TestConnection_Name(t *testing.T) {
	conn := &Connection{name: "test-server"}
	if conn.Name() != "test-server" {
		t.Errorf("expected test-server, got %q", conn.Name())
	}
}

func TestConnection_Close(t *testing.T) {
	mt := &mockTransport{}
	conn := &Connection{
		name:      "test",
		transport: mt,
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !mt.closed {
		t.Error("expected transport to be closed")
	}
}

func TestConnect_UnsupportedTransport(t *testing.T) {
	_, err := Connect("test", types.McpServerConfig{Type: "grpc"})
	if err == nil {
		t.Fatal("expected error for unsupported transport")
	}
}

func TestConnect_WebSocketMissingURL(t *testing.T) {
	_, err := Connect("test", types.McpServerConfig{Type: "ws"})
	if err == nil {
		t.Fatal("expected error for missing URL")
	}
}

func TestConnect_HTTPMissingURL(t *testing.T) {
	_, err := Connect("test", types.McpServerConfig{Type: "http"})
	if err == nil {
		t.Fatal("expected error for missing URL")
	}
}

func TestConnect_StdioMissingCommand(t *testing.T) {
	_, err := Connect("test", types.McpServerConfig{Type: "stdio"})
	if err == nil {
		t.Fatal("expected error for missing command")
	}
}

func TestConnect_SSEMissingURL(t *testing.T) {
	_, err := Connect("test", types.McpServerConfig{Type: "sse"})
	if err == nil {
		t.Fatal("expected error for missing URL")
	}
}

func TestJSONRPCRequest_Marshal(t *testing.T) {
	req := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/list",
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal(data, &parsed)
	if parsed["jsonrpc"] != "2.0" {
		t.Errorf("expected jsonrpc 2.0")
	}
	if parsed["method"] != "tools/list" {
		t.Errorf("expected method tools/list")
	}
}

// --- New tests ported from TS ---

func TestListResources_ParseMultiple(t *testing.T) {
	// Simulate a resources/list response with multiple resources.
	respBody := mustMarshal(map[string]any{
		"resources": []map[string]any{
			{"uri": "file:///a.txt", "name": "A", "mimeType": "text/plain"},
			{"uri": "file:///b.png", "name": "B", "mimeType": "image/png"},
			{"uri": "custom://data", "description": "Custom data"},
		},
	})

	var result struct {
		Resources []McpResource `json:"resources"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(result.Resources) != 3 {
		t.Fatalf("expected 3 resources, got %d", len(result.Resources))
	}
	if result.Resources[0].URI != "file:///a.txt" {
		t.Errorf("resource[0].URI = %q", result.Resources[0].URI)
	}
	if result.Resources[1].MimeType != "image/png" {
		t.Errorf("resource[1].MimeType = %q", result.Resources[1].MimeType)
	}
	if result.Resources[2].Description != "Custom data" {
		t.Errorf("resource[2].Description = %q", result.Resources[2].Description)
	}
}

func TestResourceContent_TextAndBlob(t *testing.T) {
	// Text content.
	textResp := mustMarshal(map[string]any{
		"contents": []map[string]any{
			{"uri": "file:///a.txt", "text": "hello world", "mimeType": "text/plain"},
		},
	})
	var textResult struct {
		Contents []McpResourceContent `json:"contents"`
	}
	if err := json.Unmarshal(textResp, &textResult); err != nil {
		t.Fatalf("unmarshal text: %v", err)
	}
	if len(textResult.Contents) != 1 || textResult.Contents[0].Text != "hello world" {
		t.Errorf("expected text content 'hello world', got %+v", textResult.Contents)
	}

	// Blob content (base64).
	blobResp := mustMarshal(map[string]any{
		"contents": []map[string]any{
			{"uri": "file:///img.png", "blob": "iVBORw0KGgo=", "mimeType": "image/png"},
		},
	})
	var blobResult struct {
		Contents []McpResourceContent `json:"contents"`
	}
	if err := json.Unmarshal(blobResp, &blobResult); err != nil {
		t.Fatalf("unmarshal blob: %v", err)
	}
	if blobResult.Contents[0].Blob != "iVBORw0KGgo=" {
		t.Errorf("expected blob data, got %q", blobResult.Contents[0].Blob)
	}

	// Empty response.
	emptyResp := mustMarshal(map[string]any{"contents": []map[string]any{}})
	var emptyResult struct {
		Contents []McpResourceContent `json:"contents"`
	}
	if err := json.Unmarshal(emptyResp, &emptyResult); err != nil {
		t.Fatalf("unmarshal empty: %v", err)
	}
	if len(emptyResult.Contents) != 0 {
		t.Errorf("expected 0 contents, got %d", len(emptyResult.Contents))
	}
}

func TestOAuthStore_SetGetToken(t *testing.T) {
	store := &OAuthStore{
		tokens: make(map[string]*OAuthToken),
		path:   "/dev/null", // Don't persist during test.
	}

	tok := &OAuthToken{
		AccessToken: "at-123",
		TokenType:   "Bearer",
		ExpiresAt:   time.Now().Add(1 * time.Hour),
	}
	store.SetToken("server-a", tok)

	got := store.GetToken("server-a")
	if got == nil {
		t.Fatal("expected token, got nil")
	}
	if got.AccessToken != "at-123" {
		t.Errorf("AccessToken = %q, want at-123", got.AccessToken)
	}

	// Missing server returns nil.
	if store.GetToken("nonexistent") != nil {
		t.Error("expected nil for nonexistent server")
	}
}

func TestOAuthStore_ExpiredToken(t *testing.T) {
	store := &OAuthStore{
		tokens: make(map[string]*OAuthToken),
		path:   "/dev/null",
	}

	tok := &OAuthToken{
		AccessToken: "expired-tok",
		TokenType:   "Bearer",
		ExpiresAt:   time.Now().Add(-10 * time.Minute), // Expired.
	}
	store.SetToken("server-b", tok)

	// GetToken should return nil for expired token.
	if store.GetToken("server-b") != nil {
		t.Error("expected nil for expired token")
	}
}

func TestIsExpired(t *testing.T) {
	// Nil token is expired.
	if !IsExpired(nil) {
		t.Error("nil token should be expired")
	}

	// Token expiring in 30 seconds is within the 60-second buffer, so expired.
	soon := &OAuthToken{ExpiresAt: time.Now().Add(30 * time.Second)}
	if !IsExpired(soon) {
		t.Error("token within buffer should be considered expired")
	}

	// Token expiring in 2 minutes is valid.
	later := &OAuthToken{ExpiresAt: time.Now().Add(2 * time.Minute)}
	if IsExpired(later) {
		t.Error("token expiring in 2 min should not be expired")
	}
}

func TestGeneratePKCEChallenge(t *testing.T) {
	verifier, challenge, err := GeneratePKCEChallenge()
	if err != nil {
		t.Fatalf("GeneratePKCEChallenge: %v", err)
	}
	if verifier == "" {
		t.Error("verifier should not be empty")
	}
	if challenge == "" {
		t.Error("challenge should not be empty")
	}
	if verifier == challenge {
		t.Error("verifier and challenge should differ")
	}

	// Calling twice should produce different values.
	v2, c2, _ := GeneratePKCEChallenge()
	if v2 == verifier {
		t.Error("two PKCE calls should produce different verifiers")
	}
	if c2 == challenge {
		t.Error("two PKCE calls should produce different challenges")
	}
}

func TestHTTPTransport_SessionIDTracking(t *testing.T) {
	ht := &httpTransport{
		baseURL: "http://localhost:9999",
		headers: map[string]string{},
		client:  &http.Client{},
		respCh:  make(chan json.RawMessage, 8),
	}

	// Session ID starts empty.
	ht.mu.Lock()
	if ht.sessionID != "" {
		t.Error("sessionID should start empty")
	}
	ht.mu.Unlock()

	// Simulate setting a session ID (as would happen from response header).
	ht.mu.Lock()
	ht.sessionID = "sess-abc"
	ht.mu.Unlock()

	ht.mu.Lock()
	if ht.sessionID != "sess-abc" {
		t.Errorf("sessionID = %q, want sess-abc", ht.sessionID)
	}
	ht.mu.Unlock()
}

func TestConnectionRegistry(t *testing.T) {
	conn := &Connection{name: "reg-test", tools: []ToolDef{{Name: "t1"}}}

	// Register and retrieve.
	registerConnection("reg-test", conn)
	got := getConnection("reg-test")
	if got == nil {
		t.Fatal("expected registered connection")
	}
	if got.Name() != "reg-test" {
		t.Errorf("name = %q, want reg-test", got.Name())
	}

	// Unregister and verify gone.
	unregisterConnection("reg-test")
	if getConnection("reg-test") != nil {
		t.Error("expected nil after unregister")
	}
}
