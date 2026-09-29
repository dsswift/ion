package server

// dispatch_mcp_update_test.go — mcp_add with an OAuth client, and mcp_update,
// driven through the full JSON-decode → dispatch path.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func mcpStatusNamed(t *testing.T, lines []string, name string) types.McpServerStatus {
	t.Helper()
	evt := findMcpEvent(t, lines, types.EventMcpServers)
	if evt == nil {
		t.Fatalf("no engine_mcp_servers event delivered, lines: %v", lines)
	}
	for _, status := range evt.McpServers {
		if status.Name == name {
			return status
		}
	}
	t.Fatalf("snapshot has no server %q: %+v", name, evt.McpServers)
	return types.McpServerStatus{}
}

// seedMcpToken writes a valid stored token for a server, as a completed login
// leaves it. Call it before the first command: the token store loads the file
// once per HOME.
func seedMcpToken(t *testing.T, name string) {
	t.Helper()
	dir := utils.IonDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := `{"` + name + `":{"access_token":"at","token_type":"Bearer","expires_at":"` +
		time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}}`
	if err := os.WriteFile(filepath.Join(dir, "mcp-tokens.json"), []byte(body), 0o600); err != nil {
		t.Fatalf("write tokens: %v", err)
	}
	if !mcp.IsAuthenticated(name) {
		t.Fatal("precondition: seeded token is not visible to the store")
	}
}

func TestDispatchMcpAdd_OAuthClientPersistedAndReportedWithoutSecret(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "exchange", "mcpUrl": "https://api.example.test/mcp",
		"mcpOAuth": map[string]any{"clientId": "client-1", "clientSecret": "top-secret", "scope": "api://x/.default"},
	})
	lines := readLines(t, conn, 2, 3*time.Second)

	for _, l := range lines {
		if strings.Contains(l, "top-secret") {
			t.Fatalf("the client secret reached the wire: %s", l)
		}
	}
	status := mcpStatusNamed(t, lines, "exchange")
	if status.OAuth == nil || status.OAuth.ClientID != "client-1" || status.OAuth.Scope != "api://x/.default" || !status.OAuth.HasClientSecret {
		t.Errorf("snapshot oauth = %+v", status.OAuth)
	}

	entry, _ := readEngineConfigServers(t)["exchange"].(map[string]any) //nolint:errcheck // nil fails below
	oauth, _ := entry["oauth"].(map[string]any)                         //nolint:errcheck // nil fails below
	if oauth["client_id"] != "client-1" || oauth["client_secret"] != "top-secret" {
		t.Errorf("persisted oauth = %#v", oauth)
	}
}

func TestDispatchMcpAdd_EmptyOAuthWritesNoBlock(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "plain", "mcpUrl": "https://api.example.test/mcp", "mcpOAuth": map[string]any{},
	})
	readLines(t, conn, 2, 3*time.Second)

	entry, _ := readEngineConfigServers(t)["plain"].(map[string]any) //nolint:errcheck // nil fails below
	if _, present := entry["oauth"]; present {
		t.Errorf("an empty oauth block was written: %#v", entry)
	}
}

func TestDispatchMcpUpdate_OAuthChangeClearsCredentialsAndKeepsSecret(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	seedMcpToken(t, "exchange")
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "exchange", "mcpUrl": "https://api.example.test/mcp",
		"mcpHeaders": map[string]string{"X-Tenant": "t1"},
		"mcpOAuth":   map[string]any{"clientId": "client-1", "clientSecret": "top-secret"},
	})
	readLines(t, conn, 2, 3*time.Second)

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_update", "requestId": "req-update",
		"mcpName": "exchange", "mcpOAuth": map[string]any{"clientId": "client-2"},
	})
	lines := readLines(t, conn, 2, 3*time.Second)

	resultSeen := false
	for _, l := range lines {
		if strings.Contains(l, "req-update") && strings.Contains(l, `"credentialsCleared":true`) {
			resultSeen = true
		}
	}
	if !resultSeen {
		t.Errorf("no result reporting cleared credentials, lines: %v", lines)
	}
	status := mcpStatusNamed(t, lines, "exchange")
	if status.Authenticated {
		t.Error("a token minted for the old client must not survive a client change")
	}
	if status.OAuth == nil || status.OAuth.ClientID != "client-2" || !status.OAuth.HasClientSecret {
		t.Errorf("snapshot oauth = %+v, want client-2 with the stored secret kept", status.OAuth)
	}

	entry, _ := readEngineConfigServers(t)["exchange"].(map[string]any) //nolint:errcheck // nil fails below
	if entry["headers"] == nil {
		t.Error("mcp_update dropped headers it did not name")
	}
}

func TestDispatchMcpUpdate_UnchangedKeepsCredentials(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	seedMcpToken(t, "exchange")
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "exchange", "mcpUrl": "https://api.example.test/mcp",
		"mcpOAuth": map[string]any{"clientId": "client-1"},
	})
	readLines(t, conn, 2, 3*time.Second)

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_update", "requestId": "req-update",
		"mcpName": "exchange", "mcpOAuth": map[string]any{"clientId": "client-1"},
	})
	lines := readLines(t, conn, 2, 3*time.Second)

	if !mcpStatusNamed(t, lines, "exchange").Authenticated {
		t.Errorf("an update that changes nothing must keep the stored token, lines: %v", lines)
	}
}

func TestDispatchMcpUpdate_UnknownServerIsAnError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_update", "requestId": "req-update",
		"mcpName": "ghost", "mcpUrl": "https://api.example.test/mcp",
	})
	lines := readLines(t, conn, 1, 2*time.Second)
	found := false
	for _, l := range lines {
		if strings.Contains(l, "req-update") && strings.Contains(l, "not configured") {
			found = true
		}
	}
	if !found {
		t.Errorf("no refusal naming the missing server, lines: %v", lines)
	}
}

func TestDispatchMcpUpdate_NoStoredCredentialsReportsNoneCleared(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_add", "requestId": "req-add",
		"mcpName": "exchange", "mcpUrl": "https://api.example.test/mcp",
	})
	readLines(t, conn, 2, 3*time.Second)

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "mcp_update", "requestId": "req-update",
		"mcpName": "exchange", "mcpOAuth": map[string]any{"clientId": "client-1"},
	})
	lines := readLines(t, conn, 2, 3*time.Second)
	for _, l := range lines {
		if strings.Contains(l, "req-update") && !strings.Contains(l, `"credentialsCleared":false`) {
			t.Errorf("a server with nothing stored must report no credentials cleared: %s", l)
		}
	}
}
