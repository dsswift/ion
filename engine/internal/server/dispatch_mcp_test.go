package server

// dispatch_mcp_test.go — end-to-end tests for the MCP administration commands.
// Each test drives the full JSON-decode → dispatch path so the wire contract
// (validation, requester-only event delivery, broadcast semantics) is exercised
// against real socket input.
//
// Test matrix:
//  1. mcp_add writes a server and broadcasts the snapshot; validation rejects
//     contradictory or incomplete definitions.
//  2. mcp_list reports configured servers with connection/authorization state.
//  3. mcp_login returns the authorization URL WITHOUT blocking the dispatch —
//     the property that keeps the socket responsive while a human is in a
//     browser.
//  4. mcp_remove deletes the entry and its stored credentials.
//  5. mcp_logout drops the token and re-broadcasts.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// findMcpEvent scans NDJSON lines for the given engine_mcp_* event type.
func findMcpEvent(t *testing.T, lines []string, eventType string) *types.EngineEvent {
	t.Helper()
	for _, l := range lines {
		if !strings.Contains(l, `"`+eventType+`"`) {
			continue
		}
		var wrapper struct {
			Event json.RawMessage `json:"event"`
		}
		if err := json.Unmarshal([]byte(l), &wrapper); err != nil {
			continue
		}
		var evt types.EngineEvent
		if err := json.Unmarshal(wrapper.Event, &evt); err != nil {
			continue
		}
		if evt.Type == eventType {
			return &evt
		}
	}
	return nil
}

// readEngineConfigServers reads the mcpServers map straight from the isolated
// HOME's engine.json, so assertions check what was actually persisted.
func readEngineConfigServers(t *testing.T) map[string]any {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("resolve HOME: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(home, ".ion", "engine.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}
		}
		t.Fatalf("read engine.json: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("engine.json is not valid JSON: %v", err)
	}
	servers, ok := raw["mcpServers"].(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return servers
}

func TestDispatchMcpAdd_WritesServerAndBroadcasts(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":          "mcp_add",
		"requestId":    "req-add",
		"mcpName":      "mobbin",
		"mcpTransport": "http",
		"mcpUrl":       "https://api.mobbin.com/mcp",
	})

	lines := readLines(t, conn, 2, 3*time.Second)

	// The snapshot broadcast must carry the new server.
	evt := findMcpEvent(t, lines, types.EventMcpServers)
	if evt == nil {
		t.Fatalf("no engine_mcp_servers event delivered, lines: %v", lines)
	}
	var found *types.McpServerStatus
	for i := range evt.McpServers {
		if evt.McpServers[i].Name == "mobbin" {
			found = &evt.McpServers[i]
		}
	}
	if found == nil {
		t.Fatalf("snapshot does not contain the added server: %+v", evt.McpServers)
	}
	if found.Transport != "http" || found.URL != "https://api.mobbin.com/mcp" {
		t.Errorf("snapshot entry = %+v", found)
	}
	if found.Authenticated {
		t.Error("a freshly added server must not report as authenticated")
	}

	// And it must be on disk, not just in the event.
	servers := readEngineConfigServers(t)
	entry, ok := servers["mobbin"].(map[string]any)
	if !ok {
		t.Fatalf("server was not persisted to engine.json: %#v", servers)
	}
	if entry["url"] != "https://api.mobbin.com/mcp" {
		t.Errorf("persisted url = %v", entry["url"])
	}
}

// TestDispatchMcpAdd_InfersTransport pins the least-opinionated default: a
// consumer that supplies only a URL gets http, and one supplying only a command
// gets stdio, without having to restate the obvious.
func TestDispatchMcpAdd_InfersTransport(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-url",
		"mcpName": "by-url", "mcpUrl": "https://example.test/mcp",
	})
	readLines(t, conn, 2, 3*time.Second)

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-cmd",
		"mcpName": "by-command", "mcpCommand": "npx", "mcpArgs": []string{"-y", "some-server"},
	})
	readLines(t, conn, 2, 3*time.Second)

	servers := readEngineConfigServers(t)

	byURL, ok := servers["by-url"].(map[string]any)
	if !ok {
		t.Fatalf("by-url server missing: %#v", servers)
	}
	if byURL["type"] != "http" {
		t.Errorf("a URL-only add resolved to type %v, want http", byURL["type"])
	}

	byCommand, ok := servers["by-command"].(map[string]any)
	if !ok {
		t.Fatalf("by-command server missing: %#v", servers)
	}
	if byCommand["type"] != "stdio" {
		t.Errorf("a command-only add resolved to type %v, want stdio", byCommand["type"])
	}
}

// TestDispatchMcpAdd_RejectsInvalidDefinitions pins that contradictory or
// incomplete definitions are refused with a reason, rather than written to disk
// and failing later at connect time.
func TestDispatchMcpAdd_RejectsInvalidDefinitions(t *testing.T) {
	cases := []struct {
		label   string
		payload map[string]interface{}
		wantMsg string
	}{
		{
			// No mcpName is rejected by the parser (see
			// TestDispatchMcp_MissingNameIsRejectedAtTheWire); every other case
			// here reaches the dispatch and gets a specific reason.
			label:   "no name",
			payload: map[string]interface{}{"mcpUrl": "https://example.test/mcp"},
			wantMsg: "invalid command",
		},
		{
			label:   "neither url nor command",
			payload: map[string]interface{}{"mcpName": "empty"},
			wantMsg: "requires either mcpUrl",
		},
		{
			label:   "http with no url",
			payload: map[string]interface{}{"mcpName": "x", "mcpTransport": "http", "mcpCommand": "cat"},
			wantMsg: "requires mcpUrl",
		},
		{
			label:   "stdio with a url",
			payload: map[string]interface{}{"mcpName": "x", "mcpTransport": "stdio", "mcpUrl": "https://example.test/mcp"},
			wantMsg: "requires mcpCommand",
		},
		{
			label:   "unknown transport",
			payload: map[string]interface{}{"mcpName": "x", "mcpTransport": "carrier-pigeon", "mcpUrl": "https://example.test/mcp"},
			wantMsg: "unsupported MCP transport",
		},
		{
			label:   "name with the tool separator",
			payload: map[string]interface{}{"mcpName": "bad__name", "mcpUrl": "https://example.test/mcp"},
			wantMsg: "invalid MCP server name",
		},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			srv := newShortPathTestServer(t, newMockBackend())
			conn := dialServer(t, srv)
			t.Cleanup(func() { conn.Close() })

			payload := map[string]interface{}{"cmd": "mcp_add", "requestId": "req-bad"}
			for k, v := range tc.payload {
				payload[k] = v
			}
			sendJSON(t, conn, payload)

			lines := readLines(t, conn, 1, 2*time.Second)
			found := false
			for _, l := range lines {
				if strings.Contains(l, "req-bad") && strings.Contains(l, tc.wantMsg) {
					found = true
				}
			}
			if !found {
				t.Errorf("expected an error containing %q, got %v", tc.wantMsg, lines)
			}
			if len(readEngineConfigServers(t)) != 0 {
				t.Error("a rejected definition must not be written to engine.json")
			}
		})
	}
}

func TestDispatchMcpList_ReportsConfiguredServers(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "srv-a", "mcpUrl": "https://a.example.test/mcp",
	})
	readLines(t, conn, 2, 3*time.Second)

	sendJSON(t, conn, map[string]interface{}{"cmd": "mcp_list", "requestId": "req-list"})
	lines := readLines(t, conn, 2, 3*time.Second)

	evt := findMcpEvent(t, lines, types.EventMcpServers)
	if evt == nil {
		t.Fatalf("mcp_list delivered no engine_mcp_servers event, lines: %v", lines)
	}
	if len(evt.McpServers) != 1 || evt.McpServers[0].Name != "srv-a" {
		t.Fatalf("snapshot = %+v, want the single configured server", evt.McpServers)
	}
	status := evt.McpServers[0]
	if status.Connected {
		t.Error("a server with no live session must not report as connected")
	}
	if status.Authenticated {
		t.Error("a server with no stored token must not report as authenticated")
	}
}

// TestDispatchMcpLogin_ReturnsURLWithoutBlocking is the core dispatch-contract
// pin: the command must answer with the authorization URL immediately, while
// the operator is still in their browser. A dispatch that waited for the token
// exchange would hold the client's read loop for up to five minutes.
func TestDispatchMcpLogin_ReturnsURLWithoutBlocking(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	// An authorization server supporting discovery + dynamic registration.
	mux := http.NewServeMux()
	authSrv := httptest.NewServer(mux)
	defer authSrv.Close()
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewEncoder(w).Encode(map[string]any{
			"resource":              authSrv.URL + "/mcp",
			"authorization_servers": []string{authSrv.URL},
			"scopes_supported":      []string{"openid"},
		}); err != nil {
			t.Errorf("encode resource metadata: %v", err)
		}
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewEncoder(w).Encode(map[string]any{
			"issuer":                           authSrv.URL,
			"authorization_endpoint":           authSrv.URL + "/authorize",
			"token_endpoint":                   authSrv.URL + "/token",
			"registration_endpoint":            authSrv.URL + "/register",
			"code_challenge_methods_supported": []string{"S256"},
		}); err != nil {
			t.Errorf("encode auth server metadata: %v", err)
		}
	})
	mux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		if err := json.NewEncoder(w).Encode(map[string]any{"client_id": "dcr-client"}); err != nil {
			t.Errorf("encode registration: %v", err)
		}
	})

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "needs-auth", "mcpUrl": authSrv.URL + "/mcp",
	})
	readLines(t, conn, 2, 3*time.Second)

	start := time.Now()
	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_login", "requestId": "req-login", "mcpName": "needs-auth",
	})
	lines := readLines(t, conn, 2, 10*time.Second)
	elapsed := time.Since(start)

	evt := findMcpEvent(t, lines, types.EventMcpLoginURL)
	if evt == nil {
		t.Fatalf("no engine_mcp_login_url event delivered, lines: %v", lines)
	}
	if evt.McpServerName != "needs-auth" {
		t.Errorf("event server name = %q, want the server being authorized", evt.McpServerName)
	}
	if evt.McpAuthorizationURL == "" {
		t.Fatal("engine_mcp_login_url carried no authorization URL")
	}
	if !strings.Contains(evt.McpAuthorizationURL, "code_challenge_method=S256") {
		t.Errorf("authorization URL is not an S256 PKCE request: %s", evt.McpAuthorizationURL)
	}
	if !strings.Contains(evt.McpAuthorizationURL, "client_id=dcr-client") {
		t.Errorf("authorization URL does not use the dynamically registered client: %s", evt.McpAuthorizationURL)
	}
	// The exchange has NOT happened — nobody visited the callback. The dispatch
	// still returned, which is the property under test.
	if elapsed > 8*time.Second {
		t.Errorf("mcp_login took %s; the dispatch must not wait for the token exchange", elapsed)
	}
}

// TestDispatchMcpLogin_UnconfiguredServerNamesRemediation pins that a login for
// an unknown server explains what to do, since "not found" alone cannot
// distinguish "never added" from "pruned by enterprise policy".
func TestDispatchMcpLogin_UnconfiguredServerNamesRemediation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_login", "requestId": "req-login", "mcpName": "ghost",
	})
	lines := readLines(t, conn, 1, 2*time.Second)

	found := false
	for _, l := range lines {
		if strings.Contains(l, "req-login") && strings.Contains(l, "not configured") &&
			strings.Contains(l, "enterprise policy") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a remediation-bearing error, got %v", lines)
	}
}

// TestDispatchMcp_MissingNameIsRejectedAtTheWire pins that every name-addressed
// MCP command requires mcpName.
//
// The rejection happens in ParseClientCommand (validateRaw), not in the
// dispatch: a frame with no server name cannot be acted on by any of these
// commands, so it is not a well-formed command at all. The dispatch keeps its
// own guard as well — it is reachable by an in-process caller that bypasses the
// parser — but over the wire this is the error a consumer sees.
func TestDispatchMcp_MissingNameIsRejectedAtTheWire(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	for _, cmd := range []string{"mcp_login", "mcp_logout", "mcp_remove", "mcp_add"} {
		sendJSON(t, conn, map[string]interface{}{"cmd": cmd, "requestId": "req-" + cmd})
		lines := readLines(t, conn, 1, 2*time.Second)
		found := false
		for _, l := range lines {
			if strings.Contains(l, "req-"+cmd) && strings.Contains(l, "invalid command") {
				found = true
			}
		}
		if !found {
			t.Errorf("%s with no mcpName: expected wire-level rejection, got %v", cmd, lines)
		}
	}

	// Nothing was written by the rejected frames.
	if len(readEngineConfigServers(t)) != 0 {
		t.Error("a rejected command must not modify engine.json")
	}
}

func TestDispatchMcpRemove_DeletesEntry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "temp", "mcpUrl": "https://example.test/mcp",
	})
	readLines(t, conn, 2, 3*time.Second)
	if len(readEngineConfigServers(t)) != 1 {
		t.Fatal("precondition: server should be configured")
	}

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_remove", "requestId": "req-remove", "mcpName": "temp",
	})
	lines := readLines(t, conn, 2, 3*time.Second)

	if servers := readEngineConfigServers(t); len(servers) != 0 {
		t.Errorf("server was not removed from engine.json: %#v", servers)
	}
	evt := findMcpEvent(t, lines, types.EventMcpServers)
	if evt == nil {
		t.Fatalf("remove did not broadcast a snapshot, lines: %v", lines)
	}
	if len(evt.McpServers) != 0 {
		t.Errorf("post-remove snapshot = %+v, want empty", evt.McpServers)
	}
}

func TestDispatchMcpRemove_UnknownServerIsAnError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	// A configured server, so the failure is specifically "that name is not
	// here" rather than "nothing is configured".
	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "real", "mcpUrl": "https://example.test/mcp",
	})
	readLines(t, conn, 2, 3*time.Second)

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_remove", "requestId": "req-remove", "mcpName": "ghost",
	})
	lines := readLines(t, conn, 1, 2*time.Second)

	found := false
	for _, l := range lines {
		if strings.Contains(l, "req-remove") && strings.Contains(l, "ghost") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected an error naming the unknown server, got %v", lines)
	}
	// The real server must survive a failed removal of a different name.
	if servers := readEngineConfigServers(t); len(servers) != 1 {
		t.Errorf("a failed remove disturbed the configured servers: %#v", servers)
	}
}

func TestDispatchMcpLogout_BroadcastsSnapshot(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "srv", "mcpUrl": "https://example.test/mcp",
	})
	readLines(t, conn, 2, 3*time.Second)

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_logout", "requestId": "req-logout", "mcpName": "srv",
	})
	lines := readLines(t, conn, 2, 3*time.Second)

	evt := findMcpEvent(t, lines, types.EventMcpServers)
	if evt == nil {
		t.Fatalf("logout did not broadcast a snapshot, lines: %v", lines)
	}
	if len(evt.McpServers) != 1 {
		t.Fatalf("snapshot = %+v, want the still-configured server", evt.McpServers)
	}
	if evt.McpServers[0].Authenticated {
		t.Error("server must not report as authenticated after logout")
	}
	// Logout removes credentials, never the configuration.
	if len(readEngineConfigServers(t)) != 1 {
		t.Error("logout must not remove the server from engine.json")
	}
}
