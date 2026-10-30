package session

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// A server the session's config brings joins the configured set under the
// same rules: an unaddressable name, a name a configured server holds, or a
// policy denial is refused, and the configured map is left alone.
func TestWithSessionMcpServers(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	configured := map[string]types.McpServerConfig{"ops": {Type: "http", URL: "http://ops"}}
	session := map[string]types.McpServerConfig{
		"t3-code": {Type: "stdio", Command: "t3", Args: []string{"acp-mcp-bridge"}},
		"ops":     {Type: "http", URL: "http://shadow"},
		"bad__x":  {Type: "stdio", Command: "x"},
	}
	merged := withSessionMcpServers("k", configured, session)
	if len(merged) != 2 || merged["ops"].URL != "http://ops" || merged["t3-code"].Command != "t3" {
		t.Fatalf("merged = %+v", merged)
	}
	if len(configured) != 1 {
		t.Fatalf("configured map was modified: %+v", configured)
	}
	if same := withSessionMcpServers("k", configured, nil); len(same) != 1 {
		t.Fatalf("no session servers should return the configured set: %+v", same)
	}
}

// A session-scoped server connects at the first prompt, beside nothing from
// engine.json, and its tools are the session's.
func TestFirstDispatch_ConnectsSessionScopedServer(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeUserEngineConfig(t, `{"mcpServers":{}}`)
	mcpSrv := mcpTestServer(t, "t3_thread_read")
	forbidden := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("session start contacted a session-scoped MCP server; the connect must be lazy")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer forbidden.Close()

	mgr := NewManager(newMockBackend())
	key := "mcp-session-scoped"
	cfg := types.EngineConfig{ProfileID: "test", McpServers: map[string]types.McpServerConfig{
		"t3-code": {Type: "http", URL: mcpSrv.URL},
	}}
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown
	if conns := mgr.mcpConnectionsFor(key); len(conns) != 0 {
		t.Fatalf("session start connected %d server(s); must be 0", len(conns))
	}
	forbidden.Close()

	dispatchPrompt(t, mgr, key)
	conns := mgr.mcpConnectionsFor(key)
	if len(conns) != 1 || conns[0].Name() != "t3-code" {
		t.Fatalf("connected servers = %+v, want the session's t3-code server", conns)
	}
	if tools := conns[0].Tools(); len(tools) != 1 || tools[0].Name != "t3_thread_read" {
		t.Fatalf("tools = %+v", tools)
	}
}
