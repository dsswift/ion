package session

// start_session_mcp_test.go — pins that MCP servers are resolved fresh at
// session start rather than from the boot-cached config.
//
// The engine is a long-lived launchd daemon. Reading the server map from the
// config captured at process start means `ion mcp add` (or a client's mcp_add)
// has no effect until the daemon restarts — and restarting kills every live
// conversation. These tests fail against the boot-cached read.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// mcpTestServer stands up a minimal MCP server that answers initialize and
// tools/list over the StreamableHTTP transport, so a real mcp.Connect against
// it succeeds and the session ends up holding a live connection.
func mcpTestServer(t *testing.T, toolName string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode rpc request: %v", err)
			return
		}
		result := map[string]any{}
		if req.Method == "tools/list" {
			result["tools"] = []map[string]any{
				{"name": toolName, "description": "fixture tool", "inputSchema": map[string]any{"type": "object"}},
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": req.ID, "result": result,
		}); err != nil {
			t.Errorf("encode rpc response: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

// writeUserEngineConfig writes ~/.ion/engine.json under the test's isolated
// HOME. Callers must have already pointed HOME at a temp dir.
func writeUserEngineConfig(t *testing.T, content string) {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("resolve HOME: %v", err)
	}
	ionDir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(ionDir, 0o700); err != nil {
		t.Fatalf("mkdir .ion: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), []byte(content), 0o600); err != nil {
		t.Fatalf("write engine.json: %v", err)
	}
}

// TestStartSession_ConnectsServerAddedAfterDaemonStart is the no-restart pin.
// The Manager is constructed (and SetConfig'd) BEFORE the server exists in
// engine.json, exactly as a running daemon would be. A boot-cached read finds
// no servers and connects nothing.
func TestStartSession_ConnectsServerAddedAfterDaemonStart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeUserEngineConfig(t, `{"mcpServers":{}}`)

	mcpSrv := mcpTestServer(t, "fixture_search")

	mgr := NewManager(newMockBackend())
	// Mirror the daemon: config is captured at startup, when no server exists.
	mgr.SetConfig(&types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{},
	})

	// Operator runs `ion mcp add` while the daemon is running.
	writeUserEngineConfig(t, `{"mcpServers":{"added-live":{"type":"http","url":"`+mcpSrv.URL+`"}}}`)

	key := "mcp-fresh"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown

	conns := mgr.mcpConnectionsFor(key)
	if len(conns) != 1 {
		t.Fatalf("connected MCP servers = %d, want 1; a server added after startup must connect without a daemon restart", len(conns))
	}
	if conns[0].Name() != "added-live" {
		t.Errorf("connected server = %q, want \"added-live\"", conns[0].Name())
	}
	if tools := conns[0].Tools(); len(tools) != 1 || tools[0].Name != "fixture_search" {
		t.Errorf("tools = %+v, want the fixture's single tool", tools)
	}
}

// TestStartSession_SkipsServerRemovedAfterDaemonStart is the mirror case: a
// server the operator removed must not be connected from a stale cache.
// Connecting it would resurrect a server the operator believes is gone.
func TestStartSession_SkipsServerRemovedAfterDaemonStart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mcpSrv := mcpTestServer(t, "fixture_search")
	writeUserEngineConfig(t, `{"mcpServers":{"going-away":{"type":"http","url":"`+mcpSrv.URL+`"}}}`)

	mgr := NewManager(newMockBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			"going-away": {Type: "http", URL: mcpSrv.URL},
		},
	})

	// Operator runs `ion mcp remove going-away`.
	writeUserEngineConfig(t, `{"mcpServers":{}}`)

	key := "mcp-removed"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown

	if conns := mgr.mcpConnectionsFor(key); len(conns) != 0 {
		t.Errorf("connected MCP servers = %d, want 0; a removed server must not connect from a stale cache", len(conns))
	}
}

// TestStartSession_EnterpriseDenylistPrunesServer pins that resolution runs the
// enterprise enforcement pass: a denylisted server must not connect even when
// it sits in the operator's engine.json.
func TestStartSession_EnterpriseDenylistPrunesServer(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mcpSrv := mcpTestServer(t, "fixture_search")
	writeUserEngineConfig(t, `{"mcpServers":{"forbidden":{"type":"http","url":"`+mcpSrv.URL+`"}}}`)

	entPath := filepath.Join(t.TempDir(), "enterprise.json")
	if err := os.WriteFile(entPath, []byte(`{"mcpDenylist":["forbidden"]}`), 0o600); err != nil {
		t.Fatalf("write enterprise config: %v", err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", entPath)

	mgr := NewManager(newMockBackend())
	key := "mcp-denied"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown

	if conns := mgr.mcpConnectionsFor(key); len(conns) != 0 {
		t.Errorf("connected MCP servers = %d, want 0; enterprise policy must prune before connect", len(conns))
	}
}
