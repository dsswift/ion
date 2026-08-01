package session

// start_session_mcp_test.go — pins the lazy MCP connect: nothing at session
// start, everything at the first prompt dispatch.
//
// Session start must not pay for network I/O the session may never use. A
// desktop rehydrating dozens of tabs calls StartSession once per tab, serially;
// when the connect lived there, one healthy remote server cost every tab ~1.7s
// (measured: 20 tabs, 32 seconds of blocked rehydration) and one UNREACHABLE
// server cost every tab up to two 30-second metadata timeouts. The connect now
// runs once per session at the first dispatch, so only sessions that actually
// run a prompt pay it.
//
// The lazy seam keeps the properties the eager loop had, and these tests pin
// both halves: servers resolve fresh from engine.json (an `ion mcp add` applies
// with no daemon restart), and enterprise policy prunes before connect.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

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

// dispatchPrompt drives one prompt through SendPrompt against the mock
// backend, which is the seam where the lazy MCP connect runs.
func dispatchPrompt(t *testing.T, mgr *Manager, key string) {
	t.Helper()
	if err := mgr.SendPrompt(key, "hello", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
}

// TestStartSession_DoesNotConnectMcp is the rehydration pin: session start must
// perform NO MCP connect, even with a server configured. This is the test that
// fails against the old eager loop.
func TestStartSession_DoesNotConnectMcp(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	// A server whose every request fails the test: session start must not
	// contact it at all.
	forbidden := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("session start contacted the MCP server; the connect must be lazy")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer forbidden.Close()
	writeUserEngineConfig(t, `{"mcpServers":{"srv":{"type":"http","url":"`+forbidden.URL+`"}}}`)

	mgr := NewManager(newMockBackend())
	key := "mcp-lazy"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown

	if conns := mgr.mcpConnectionsFor(key); len(conns) != 0 {
		t.Errorf("session start connected %d MCP server(s); must be 0", len(conns))
	}
}

// TestFirstDispatch_ConnectsServerAddedAfterDaemonStart is the no-restart pin,
// moved to the dispatch seam. The Manager is constructed (and SetConfig'd)
// BEFORE the server exists in engine.json, exactly as a running daemon would
// be; the first prompt must connect it. A boot-cached read finds no servers.
func TestFirstDispatch_ConnectsServerAddedAfterDaemonStart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeUserEngineConfig(t, `{"mcpServers":{}}`)

	mcpSrv := mcpTestServer(t, "fixture_search")

	mgr := NewManager(newMockBackend())
	// Mirror the daemon: config is captured at startup, when no server exists.
	mgr.SetConfig(&types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{},
	})

	key := "mcp-fresh"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown

	// Operator runs `ion mcp add` while the daemon is running — AFTER the
	// session started, which the lazy connect also tolerates.
	writeUserEngineConfig(t, `{"mcpServers":{"added-live":{"type":"http","url":"`+mcpSrv.URL+`"}}}`)

	dispatchPrompt(t, mgr, key)

	conns := mgr.mcpConnectionsFor(key)
	if len(conns) != 1 {
		t.Fatalf("connected MCP servers = %d, want 1; a server added after startup must connect at the next dispatch without a daemon restart", len(conns))
	}
	if conns[0].Name() != "added-live" {
		t.Errorf("connected server = %q, want \"added-live\"", conns[0].Name())
	}
	if tools := conns[0].Tools(); len(tools) != 1 || tools[0].Name != "fixture_search" {
		t.Errorf("tools = %+v, want the fixture's single tool", tools)
	}
}

// TestFirstDispatch_ConnectsOnlyOnce pins the single-flight: a second prompt
// must reuse the connection, not dial again.
func TestFirstDispatch_ConnectsOnlyOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	initializeCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode: %v", err)
			return
		}
		if req.Method == "initialize" {
			initializeCount++
		}
		result := map[string]any{}
		if req.Method == "tools/list" {
			result["tools"] = []map[string]any{{"name": "x", "inputSchema": map[string]any{}}}
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	defer server.Close()
	writeUserEngineConfig(t, `{"mcpServers":{"srv":{"type":"http","url":"`+server.URL+`"}}}`)

	mb := newMockBackend()
	mgr := NewManager(mb)
	key := "mcp-once"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown

	dispatchPrompt(t, mgr, key)
	// Finish the first run so the second prompt dispatches rather than queues.
	keys := mb.startedKeys()
	if len(keys) == 0 {
		t.Fatal("no run started for the first prompt")
	}
	code := 0
	mb.emitExit(keys[len(keys)-1], &code, nil, "")

	dispatchPrompt(t, mgr, key)

	if initializeCount != 1 {
		t.Errorf("initialize called %d times across two dispatches, want 1 (single-flight per session)", initializeCount)
	}
	if conns := mgr.mcpConnectionsFor(key); len(conns) != 1 {
		t.Errorf("connections = %d, want 1", len(conns))
	}
}

// TestFirstDispatch_SkipsServerRemovedAfterDaemonStart is the mirror case: a
// server the operator removed before the first prompt must not be connected
// from any cache. Connecting it would resurrect a server the operator believes
// is gone.
func TestFirstDispatch_SkipsServerRemovedAfterDaemonStart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mcpSrv := mcpTestServer(t, "fixture_search")
	writeUserEngineConfig(t, `{"mcpServers":{"going-away":{"type":"http","url":"`+mcpSrv.URL+`"}}}`)

	mgr := NewManager(newMockBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			"going-away": {Type: "http", URL: mcpSrv.URL},
		},
	})

	key := "mcp-removed"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown

	// Operator runs `ion mcp remove going-away` before ever prompting.
	writeUserEngineConfig(t, `{"mcpServers":{}}`)

	dispatchPrompt(t, mgr, key)

	if conns := mgr.mcpConnectionsFor(key); len(conns) != 0 {
		t.Errorf("connected MCP servers = %d, want 0; a removed server must not connect from a stale cache", len(conns))
	}
}

// TestFirstDispatch_EnterpriseDenylistPrunesServer pins that resolution runs the
// enterprise enforcement pass at the lazy seam: a denylisted server must not
// connect even when it sits in the operator's engine.json.
func TestFirstDispatch_EnterpriseDenylistPrunesServer(t *testing.T) {
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

	dispatchPrompt(t, mgr, key)

	if conns := mgr.mcpConnectionsFor(key); len(conns) != 0 {
		t.Errorf("connected MCP servers = %d, want 0; enterprise policy must prune before connect", len(conns))
	}
}

// TestReconnectSkipsNeverConnectedSessions pins that a post-login reconnect
// sweep does not eagerly connect idle sessions. Reconnecting a session that
// never ran its lazy connect would reintroduce the per-tab network cost at
// every login — the exact stall the lazy connect removed. Idle sessions pick
// the refreshed credential up at their own first dispatch.
func TestReconnectSkipsNeverConnectedSessions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	contacted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contacted = true
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode: %v", err)
			return
		}
		result := map[string]any{}
		if req.Method == "tools/list" {
			result["tools"] = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	defer server.Close()
	writeUserEngineConfig(t, `{"mcpServers":{"srv":{"type":"http","url":"`+server.URL+`"}}}`)

	mgr := NewManager(newMockBackend())
	key := "idle-tab"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown

	// A login completed elsewhere; the sweep runs.
	reconnected := mgr.ReconnectMcpServer("srv")

	if reconnected != 0 {
		t.Errorf("reconnected %d idle session(s), want 0", reconnected)
	}
	if contacted {
		t.Error("the reconnect sweep contacted the server for a session that never connected")
	}
}

// TestRehydrationIsNotBlockedByUnreachableServer is the scenario that motivated
// the lazy connect, in miniature: many sessions started back-to-back (a desktop
// rehydrating its tabs) with an MCP server configured that CANNOT be reached.
// Under the eager connect each StartSession blocked on network timeouts —
// up to 2×30s per session — so rehydration took minutes. Lazily, all session
// starts complete without any network wait at all.
func TestRehydrationIsNotBlockedByUnreachableServer(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	// A TCP-black-hole address: connecting hangs rather than refusing, which is
	// the pathological case (a refused connect fails fast; a firewalled or
	// asleep host does not). 203.0.113.0/24 is TEST-NET-3, never routable.
	writeUserEngineConfig(t, `{"mcpServers":{"dead":{"type":"http","url":"http://203.0.113.1:9/mcp"}}}`)

	mgr := NewManager(newMockBackend())

	start := time.Now()
	const tabs = 10
	for i := 0; i < tabs; i++ {
		key := fmt.Sprintf("tab-%d", i)
		if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
			t.Fatalf("StartSession %s: %v", key, err)
		}
		t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown
	}
	elapsed := time.Since(start)

	// Generous bound: rehydration does extension/skill/plugin work, but no
	// network. Under the eager connect this took tabs × dial-timeout and only
	// an unreasonable bound would pass.
	if elapsed > 5*time.Second {
		t.Errorf("starting %d sessions with an unreachable MCP server took %s; session start must not wait on MCP", tabs, elapsed)
	}
}
