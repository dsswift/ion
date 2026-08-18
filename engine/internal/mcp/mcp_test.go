package mcp

import (
	"encoding/json"
	"testing"
	"time"

	mcpgo "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dsswift/ion/engine/internal/types"
)

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

func TestConnection_Tools_ReturnsDefensiveCopy(t *testing.T) {
	conn := &Connection{
		name:  "test",
		tools: []ToolDef{{Name: "original"}},
	}
	tools := conn.Tools()
	tools[0].Name = "mutated"
	if conn.Tools()[0].Name != "original" {
		t.Error("Tools() should return a copy, not a reference to internal slice")
	}
}

func TestConnection_Name(t *testing.T) {
	conn := &Connection{name: "test-server"}
	if conn.Name() != "test-server" {
		t.Errorf("expected test-server, got %q", conn.Name())
	}
}

func TestConnection_ProtocolVersion(t *testing.T) {
	conn := &Connection{protocolVersion: "2025-03-26"}
	if conn.ProtocolVersion() != "2025-03-26" {
		t.Errorf("got %q", conn.ProtocolVersion())
	}
}

func TestConnection_Capabilities_DefensiveCopy(t *testing.T) {
	conn := &Connection{capabilities: map[string]any{"tools": true}}
	caps := conn.Capabilities()
	caps["injected"] = true
	if _, found := conn.Capabilities()["injected"]; found {
		t.Error("Capabilities() should return a defensive copy")
	}
}

func TestConnection_Close_WithCleanup(t *testing.T) {
	called := false
	conn := &Connection{
		name:  "test",
		close: func() error { called = true; return nil },
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !called {
		t.Error("expected cleanup function to be called")
	}
}

func TestConnection_Close_NilSession(t *testing.T) {
	conn := &Connection{name: "bare"}
	if err := conn.Close(); err != nil {
		t.Fatalf("Close on bare connection: %v", err)
	}
}

func TestConnect_UnsupportedTransport(t *testing.T) {
	_, err := Connect("test", types.McpServerConfig{Type: "grpc"})
	if err == nil {
		t.Fatal("expected error for unsupported transport")
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

func TestConnect_WebSocketMissingURL(t *testing.T) {
	_, err := Connect("test", types.McpServerConfig{Type: "ws"})
	if err == nil {
		t.Fatal("expected error for websocket transport without URL")
	}
}

// --- Resource type parsing (pure JSON, no transport) ---

func TestListResources_ParseMultiple(t *testing.T) {
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

// --- OAuth / token tests ---

func TestOAuthStore_SetGetToken(t *testing.T) {
	store := &OAuthStore{
		tokens: make(map[string]*OAuthToken),
		path:   "/dev/null",
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
		ExpiresAt:   time.Now().Add(-10 * time.Minute),
	}
	store.SetToken("server-b", tok)

	if store.GetToken("server-b") != nil {
		t.Error("expected nil for expired token")
	}
}

func TestIsExpired(t *testing.T) {
	if !IsExpired(nil) {
		t.Error("nil token should be expired")
	}

	soon := &OAuthToken{ExpiresAt: time.Now().Add(30 * time.Second)}
	if !IsExpired(soon) {
		t.Error("token within buffer should be considered expired")
	}

	later := &OAuthToken{ExpiresAt: time.Now().Add(2 * time.Minute)}
	if IsExpired(later) {
		t.Error("token expiring in 2 min should not be expired")
	}
}

// --- convertToolResult (replaces old toolResultFromContent) ---

func TestConvertToolResult_Nil(t *testing.T) {
	result := convertToolResult(nil)
	if result.Content == "" {
		t.Error("nil result should produce non-empty error content")
	}
	if !result.IsError {
		t.Error("nil result should be marked as error")
	}
}

func TestConvertToolResult_TextOnly(t *testing.T) {
	result := convertToolResult(&mcpgo.CallToolResult{
		Content: []mcpgo.Content{
			&mcpgo.TextContent{Text: "hello"},
			&mcpgo.TextContent{Text: "world"},
		},
	})
	if result.Content != "hello\nworld" {
		t.Errorf("content = %q, want 'hello\\nworld'", result.Content)
	}
	if result.IsError {
		t.Error("should not be marked error")
	}
	if len(result.ContentItems) != 2 {
		t.Fatalf("expected 2 content items, got %d", len(result.ContentItems))
	}
	if result.ContentItems[0].Type != "text" || result.ContentItems[0].Text != "hello" {
		t.Errorf("content item[0] = %+v", result.ContentItems[0])
	}
}

func TestConvertToolResult_ImageContent(t *testing.T) {
	imgData := []byte("fakepngdata")
	result := convertToolResult(&mcpgo.CallToolResult{
		Content: []mcpgo.Content{
			&mcpgo.ImageContent{Data: imgData, MIMEType: "image/png"},
		},
	})
	if len(result.ContentItems) != 1 {
		t.Fatalf("expected 1 content item, got %d", len(result.ContentItems))
	}
	if result.ContentItems[0].Type != "image" {
		t.Errorf("type = %q, want image", result.ContentItems[0].Type)
	}
	if result.ContentItems[0].MimeType != "image/png" {
		t.Errorf("mimeType = %q", result.ContentItems[0].MimeType)
	}
	if len(result.EphemeralImages) != 1 {
		t.Errorf("expected 1 ephemeral image, got %d", len(result.EphemeralImages))
	}
}

func TestConvertToolResult_EmbeddedResourceText(t *testing.T) {
	result := convertToolResult(&mcpgo.CallToolResult{
		Content: []mcpgo.Content{
			&mcpgo.EmbeddedResource{Resource: &mcpgo.ResourceContents{
				URI: "file:///readme.md", MIMEType: "text/plain", Text: "# Hello",
			}},
		},
	})
	if len(result.ContentItems) != 1 || result.ContentItems[0].Type != "resource" {
		t.Fatalf("content items = %+v", result.ContentItems)
	}
	if result.ContentItems[0].Resource == nil {
		t.Fatal("resource should not be nil")
	}
	if result.ContentItems[0].Resource.Text != "# Hello" {
		t.Errorf("resource text = %q", result.ContentItems[0].Resource.Text)
	}
}

func TestConvertToolResult_EmbeddedResourceNilResource(t *testing.T) {
	result := convertToolResult(&mcpgo.CallToolResult{
		Content: []mcpgo.Content{
			&mcpgo.EmbeddedResource{Resource: nil},
		},
	})
	if len(result.ContentItems) != 0 {
		t.Errorf("nil embedded resource should be skipped, got %d items", len(result.ContentItems))
	}
}

func TestConvertToolResult_ResourceLink(t *testing.T) {
	result := convertToolResult(&mcpgo.CallToolResult{
		Content: []mcpgo.Content{
			&mcpgo.ResourceLink{URI: "mcp://detail", Name: "detail", Description: "details page", MIMEType: "application/json"},
		},
	})
	if len(result.ContentItems) != 1 || result.ContentItems[0].Type != "resource_link" {
		t.Fatalf("content items = %+v", result.ContentItems)
	}
	if result.ContentItems[0].URI != "mcp://detail" {
		t.Errorf("URI = %q", result.ContentItems[0].URI)
	}
	if result.ContentItems[0].Description != "details page" {
		t.Errorf("Description = %q", result.ContentItems[0].Description)
	}
}

func TestConvertToolResult_StructuredContent(t *testing.T) {
	structured := map[string]any{"screens": float64(2)}
	result := convertToolResult(&mcpgo.CallToolResult{
		Content:           []mcpgo.Content{&mcpgo.TextContent{Text: "base text"}},
		StructuredContent: structured,
	})
	if result.Content != "base text\n{\"screens\":2}" {
		t.Errorf("content = %q", result.Content)
	}
}

func TestConvertToolResult_EmptyContent(t *testing.T) {
	result := convertToolResult(&mcpgo.CallToolResult{Content: nil})
	if result.Content == "" {
		t.Error("empty content should produce fallback message")
	}
}

func TestConvertToolResult_IsError(t *testing.T) {
	result := convertToolResult(&mcpgo.CallToolResult{
		IsError: true,
		Content: []mcpgo.Content{&mcpgo.TextContent{Text: "something failed"}},
	})
	if !result.IsError {
		t.Error("IsError should propagate")
	}
}

// --- capabilitiesMap ---

func TestCapabilitiesMap_Nil(t *testing.T) {
	out := capabilitiesMap(nil)
	if out != nil {
		t.Errorf("expected nil for nil input, got %v", out)
	}
}

func TestCapabilitiesMap_RoundTrip(t *testing.T) {
	input := map[string]any{"tools": map[string]any{"listChanged": true}}
	out := capabilitiesMap(input)
	if out == nil {
		t.Fatal("expected non-nil output")
	}
	tools, ok := out["tools"].(map[string]any)
	if !ok {
		t.Fatalf("tools not a map: %T", out["tools"])
	}
	if tools["listChanged"] != true {
		t.Errorf("listChanged = %v", tools["listChanged"])
	}
}

// --- callContext timeout ---

func TestCallContext_DefaultTimeout(t *testing.T) {
	conn := &Connection{name: "test"}
	ctx, cancel := conn.callContext(t.Context())
	defer cancel()
	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("expected deadline on context")
	}
	remaining := time.Until(deadline)
	if remaining < DefaultCallTimeout-time.Second || remaining > DefaultCallTimeout+time.Second {
		t.Errorf("expected ~%v timeout, got %v remaining", DefaultCallTimeout, remaining)
	}
}

func TestCallContext_CustomTimeout(t *testing.T) {
	conn := &Connection{name: "test", callTimeout: 10 * time.Second}
	ctx, cancel := conn.callContext(t.Context())
	defer cancel()
	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("expected deadline on context")
	}
	remaining := time.Until(deadline)
	if remaining < 9*time.Second || remaining > 11*time.Second {
		t.Errorf("expected ~10s timeout, got %v remaining", remaining)
	}
}

// --- joinNonEmpty ---

func TestJoinNonEmpty(t *testing.T) {
	cases := []struct {
		input []string
		want  string
	}{
		{nil, ""},
		{[]string{}, ""},
		{[]string{"a"}, "a"},
		{[]string{"a", "b"}, "a\nb"},
		{[]string{"a", "", "b"}, "a\nb"},
		{[]string{"", ""}, ""},
	}
	for _, tc := range cases {
		got := joinNonEmpty(tc.input)
		if got != tc.want {
			t.Errorf("joinNonEmpty(%v) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// --- newSDKTransport validation ---

func TestNewSDKTransport_EmptyDefaultsToStdio(t *testing.T) {
	_, _, err := newSDKTransport("test", types.McpServerConfig{Type: "", Command: "echo"})
	if err != nil {
		t.Fatalf("expected stdio fallback for empty type, got: %v", err)
	}
}

func TestNewSDKTransport_HTTPReturnsStreamable(t *testing.T) {
	transport, cleanup, err := newSDKTransport("test", types.McpServerConfig{Type: "http", URL: "http://localhost:9999/mcp"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if transport == nil {
		t.Fatal("expected non-nil transport")
	}
	if cleanup == nil {
		t.Fatal("expected non-nil cleanup")
	}
}

func TestNewSDKTransport_SSEReturnsTransport(t *testing.T) {
	transport, _, err := newSDKTransport("test", types.McpServerConfig{Type: "sse", URL: "http://localhost:9999/sse"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if transport == nil {
		t.Fatal("expected non-nil transport")
	}
}

// --- ClientStore ---

func TestClientStore_SetGetDelete(t *testing.T) {
	store := &ClientStore{
		clients: make(map[string]*ClientRegistration),
		path:    "/dev/null",
	}

	reg := &ClientRegistration{
		ClientID: "cid-123",
		AuthURL:  "https://auth.example.com/authorize",
		TokenURL: "https://auth.example.com/token",
	}
	store.Set("server-x", reg)

	got := store.Get("server-x")
	if got == nil {
		t.Fatal("expected registration")
	}
	if got.ClientID != "cid-123" {
		t.Errorf("ClientID = %q", got.ClientID)
	}

	if store.Get("nonexistent") != nil {
		t.Error("expected nil for missing server")
	}

	store.Delete("server-x")
	if store.Get("server-x") != nil {
		t.Error("expected nil after delete")
	}
}

func TestClientStore_NamesLegacyAdapter(t *testing.T) {
	store := &ClientStore{
		clients: make(map[string]*ClientRegistration),
		path:    "/dev/null",
	}
	store.Set("alpha", &ClientRegistration{ClientID: "a"})
	store.Set("beta", &ClientRegistration{ClientID: "b"})

	names := store.Names()
	if len(names) != 2 {
		t.Fatalf("expected 2 names, got %d", len(names))
	}
	found := map[string]bool{}
	for _, n := range names {
		found[n] = true
	}
	if !found["alpha"] || !found["beta"] {
		t.Errorf("names = %v", names)
	}
}
