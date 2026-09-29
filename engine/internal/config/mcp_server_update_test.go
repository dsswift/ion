package config

// mcp_server_update_test.go — UpdateMcpServer patches one entry and keeps
// every field the patch does not name.

import (
	"strings"
	"testing"
)

const updateSeed = `{
  "mcpServers": {
    "exchange": {
      "type": "http",
      "url": "https://api.example.test/exchange/mcp",
      "headers": {"X-Tenant": "t1"},
      "timeoutSeconds": 30,
      "futureKey": {"kept": true},
      "oauth": {"client_id": "old-client", "client_secret": "s3cret", "use_pkce": true}
    },
    "local": {"type": "stdio", "command": "npx", "args": ["-y", "srv"], "env": {"A": "1"}}
  }
}`

func updatedEntry(t *testing.T, path, name string) map[string]any {
	t.Helper()
	servers, ok := readRawTestConfig(t, path)["mcpServers"].(map[string]any)
	if !ok {
		t.Fatal("mcpServers missing after update")
	}
	entry, ok := servers[name].(map[string]any)
	if !ok {
		t.Fatalf("server %q missing after update", name)
	}
	return entry
}

func TestUpdateMcpServer_OAuthPatchKeepsUnnamedFields(t *testing.T) {
	path := seedEngineConfig(t, updateSeed)

	result, err := UpdateMcpServer("exchange", McpServerPatch{
		OAuth: &McpOAuthPatch{ClientID: "new-client", Scope: "api://x/.default offline_access"},
	})
	if err != nil {
		t.Fatalf("UpdateMcpServer: %v", err)
	}
	if !result.Changed || !result.CredentialsInvalidated {
		t.Errorf("result = %+v, want changed with credentials invalidated", result)
	}

	entry := updatedEntry(t, path, "exchange")
	if entry["url"] != "https://api.example.test/exchange/mcp" || entry["timeoutSeconds"] != float64(30) {
		t.Errorf("transport fields changed: %#v", entry)
	}
	if entry["headers"] == nil || entry["futureKey"] == nil {
		t.Errorf("fields the patch does not name were dropped: %#v", entry)
	}
	oauth, _ := entry["oauth"].(map[string]any) //nolint:errcheck // nil fails the checks below
	if oauth["client_id"] != "new-client" || oauth["scope"] != "api://x/.default offline_access" {
		t.Errorf("oauth = %#v", oauth)
	}
	if oauth["client_secret"] != "s3cret" {
		t.Error("an absent client secret must keep the stored one")
	}
	if oauth["use_pkce"] != true {
		t.Error("oauth keys the patch does not cover must be kept")
	}
}

func TestUpdateMcpServer_EmptySecretRemovesIt(t *testing.T) {
	path := seedEngineConfig(t, updateSeed)
	empty := ""
	if _, err := UpdateMcpServer("exchange", McpServerPatch{
		OAuth: &McpOAuthPatch{ClientID: "old-client", ClientSecret: &empty},
	}); err != nil {
		t.Fatalf("UpdateMcpServer: %v", err)
	}
	oauth, _ := updatedEntry(t, path, "exchange")["oauth"].(map[string]any) //nolint:errcheck // nil fails below
	if _, present := oauth["client_secret"]; present {
		t.Errorf("client_secret still stored: %#v", oauth)
	}
}

func TestUpdateMcpServer_ClearingEveryOAuthFieldDropsTheBlock(t *testing.T) {
	path := seedEngineConfig(t, `{"mcpServers":{"s":{"type":"http","url":"https://a.test/mcp","oauth":{"client_id":"c"}}}}`)
	if _, err := UpdateMcpServer("s", McpServerPatch{OAuth: &McpOAuthPatch{}}); err != nil {
		t.Fatalf("UpdateMcpServer: %v", err)
	}
	if _, present := updatedEntry(t, path, "s")["oauth"]; present {
		t.Error("an oauth block with no settings left must be removed")
	}
}

func TestUpdateMcpServer_UnchangedPatchWritesNothing(t *testing.T) {
	seedEngineConfig(t, updateSeed)
	result, err := UpdateMcpServer("exchange", McpServerPatch{URL: "https://api.example.test/exchange/mcp"})
	if err != nil {
		t.Fatalf("UpdateMcpServer: %v", err)
	}
	if result.Changed || result.CredentialsInvalidated {
		t.Errorf("result = %+v, want no change", result)
	}
}

func TestUpdateMcpServer_URLChangeInvalidatesCredentials(t *testing.T) {
	seedEngineConfig(t, updateSeed)
	result, err := UpdateMcpServer("exchange", McpServerPatch{URL: "https://api.example.test/exchange/v2/mcp"})
	if err != nil {
		t.Fatalf("UpdateMcpServer: %v", err)
	}
	if !result.CredentialsInvalidated {
		t.Error("a url change must invalidate stored credentials")
	}
}

func TestUpdateMcpServer_StdioArgsAndEnv(t *testing.T) {
	path := seedEngineConfig(t, updateSeed)
	result, err := UpdateMcpServer("local", McpServerPatch{Command: "uvx", Args: []string{"srv"}})
	if err != nil {
		t.Fatalf("UpdateMcpServer: %v", err)
	}
	if result.CredentialsInvalidated {
		t.Error("a command change has no credentials to invalidate")
	}
	entry := updatedEntry(t, path, "local")
	if entry["command"] != "uvx" || entry["env"] == nil {
		t.Errorf("entry = %#v", entry)
	}
	if args, _ := entry["args"].([]any); len(args) != 1 || args[0] != "srv" { //nolint:errcheck // nil fails the check
		t.Errorf("args = %#v", entry["args"])
	}
}

func TestUpdateMcpServer_Refusals(t *testing.T) {
	cases := []struct {
		label string
		name  string
		patch McpServerPatch
		want  string
	}{
		{"unknown server", "missing", McpServerPatch{URL: "https://a.test/mcp"}, "not configured"},
		{"url and command", "exchange", McpServerPatch{URL: "https://a.test/mcp", Command: "npx"}, "not both"},
		{"endpoint without client", "exchange", McpServerPatch{OAuth: &McpOAuthPatch{TokenURL: "https://login.test/token"}}, "client_id is required"},
		{"relative endpoint", "exchange", McpServerPatch{OAuth: &McpOAuthPatch{ClientID: "c", AuthURL: "/authorize"}}, "absolute http(s) URL"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			path := seedEngineConfig(t, updateSeed)
			_, err := UpdateMcpServer(tc.name, tc.patch)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
			oauth, _ := updatedEntry(t, path, "exchange")["oauth"].(map[string]any) //nolint:errcheck // nil fails below
			if oauth["client_id"] != "old-client" {
				t.Error("a refused update must leave engine.json untouched")
			}
		})
	}
}

// TestUpdateMcpServer_EmptyStoredKeysAreNotAChange pins the shape add writes:
// the typed oauth block stores empty endpoints as "". Re-saving the same client
// must not read as a change, or the stored token would be cleared.
func TestUpdateMcpServer_EmptyStoredKeysAreNotAChange(t *testing.T) {
	seedEngineConfig(t, `{"mcpServers":{"s":{"type":"http","url":"https://a.test/mcp","oauth":{"client_id":"c","auth_url":"","token_url":""}}}}`)
	result, err := UpdateMcpServer("s", McpServerPatch{OAuth: &McpOAuthPatch{ClientID: "c"}})
	if err != nil {
		t.Fatalf("UpdateMcpServer: %v", err)
	}
	if result.Changed || result.CredentialsInvalidated {
		t.Errorf("result = %+v, want no change", result)
	}
}
