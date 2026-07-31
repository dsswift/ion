package config

// mcp_servers_test.go — behavior pins for MCP server resolution and CRUD.
//
// The load-bearing property is non-destructiveness: engine.json holds provider
// credentials, enterprise state, and keys newer than whatever code is running.
// An add or remove that round-trips through a typed struct would silently drop
// every field the struct does not model, so these tests pin preservation of
// unrelated keys explicitly.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// seedEngineConfig points HOME at a temp dir and writes engine.json with the
// given raw content. Returns the config path.
func seedEngineConfig(t *testing.T, content string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	ionDir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(ionDir, 0o700); err != nil {
		t.Fatalf("mkdir .ion: %v", err)
	}
	path := filepath.Join(ionDir, "engine.json")
	if content != "" {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write engine.json: %v", err)
		}
	}
	return path
}

// readRawTestConfig decodes engine.json for assertions.
func readRawTestConfig(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read engine.json: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("engine.json is not valid JSON: %v", err)
	}
	return raw
}

// TestAddMcpServer_PreservesUnrelatedKeys is the central non-destructiveness
// pin: a populated engine.json must come back with every other key intact,
// including nested structures and keys this version of the code has no struct
// field for.
func TestAddMcpServer_PreservesUnrelatedKeys(t *testing.T) {
	path := seedEngineConfig(t, `{
  "backend": "hybrid",
  "defaultModel": "some-provider/some-model",
  "providers": {
    "some-provider": { "apiKey": "SECRET_ENV_VAR", "baseURL": "https://gateway.example.test" }
  },
  "limits": { "maxTurns": 1000, "planModeAllowedBashCommands": ["ls", "git log"] },
  "aFieldThisVersionDoesNotKnowAbout": { "nested": [1, 2, 3] },
  "mcpServers": {
    "existing": { "type": "stdio", "command": "cat" }
  }
}`)

	if err := AddMcpServer("mobbin", types.McpServerConfig{Type: "http", URL: "https://api.mobbin.com/mcp"}); err != nil {
		t.Fatalf("AddMcpServer: %v", err)
	}

	raw := readRawTestConfig(t, path)

	if raw["backend"] != "hybrid" {
		t.Errorf("backend = %v, want it preserved", raw["backend"])
	}
	if raw["defaultModel"] != "some-provider/some-model" {
		t.Errorf("defaultModel = %v, want it preserved", raw["defaultModel"])
	}

	// A future/unknown key must survive: dropping it is the exact failure the
	// raw-map round trip exists to prevent.
	unknown, ok := raw["aFieldThisVersionDoesNotKnowAbout"].(map[string]any)
	if !ok {
		t.Fatalf("unknown key was dropped or retyped: %#v", raw["aFieldThisVersionDoesNotKnowAbout"])
	}
	nested, ok := unknown["nested"].([]any)
	if !ok || len(nested) != 3 {
		t.Errorf("nested value under the unknown key = %#v, want a 3-element array", unknown["nested"])
	}

	// Credentials must not be disturbed.
	providers, ok := raw["providers"].(map[string]any)
	if !ok {
		t.Fatal("providers block was dropped")
	}
	provider, ok := providers["some-provider"].(map[string]any)
	if !ok {
		t.Fatal("provider entry was dropped")
	}
	if provider["apiKey"] != "SECRET_ENV_VAR" {
		t.Errorf("provider apiKey = %v, want it preserved verbatim", provider["apiKey"])
	}

	// The pre-existing server survives alongside the new one.
	servers, ok := raw["mcpServers"].(map[string]any)
	if !ok {
		t.Fatal("mcpServers is not an object")
	}
	if _, ok := servers["existing"]; !ok {
		t.Error("pre-existing MCP server was removed by the add")
	}
	added, ok := servers["mobbin"].(map[string]any)
	if !ok {
		t.Fatal("added server is missing")
	}
	if added["type"] != "http" || added["url"] != "https://api.mobbin.com/mcp" {
		t.Errorf("added server = %#v", added)
	}
}

// TestAddMcpServer_OmitsEmptyFields pins that an entry carries only what was
// set. A struct marshalled without omitempty would write a dozen empty keys
// into a file the operator reads and edits by hand.
func TestAddMcpServer_OmitsEmptyFields(t *testing.T) {
	path := seedEngineConfig(t, `{}`)

	if err := AddMcpServer("remote", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err != nil {
		t.Fatalf("AddMcpServer: %v", err)
	}

	raw := readRawTestConfig(t, path)
	servers := raw["mcpServers"].(map[string]any) //nolint:errcheck // shape asserted by the test above
	entry := servers["remote"].(map[string]any)   //nolint:errcheck // shape asserted by the test above

	for _, absent := range []string{"command", "args", "env", "headers", "oauth", "timeoutSeconds", "forwardUserToken"} {
		if _, present := entry[absent]; present {
			t.Errorf("unset field %q was written to engine.json", absent)
		}
	}
	if len(entry) != 2 {
		t.Errorf("entry has %d keys (%#v), want exactly type and url", len(entry), entry)
	}
}

// TestAddMcpServer_CreatesFileWhenAbsent pins the fresh-install path: the first
// add must work with no engine.json at all.
func TestAddMcpServer_CreatesFileWhenAbsent(t *testing.T) {
	path := seedEngineConfig(t, "")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("precondition: engine.json should not exist, stat err = %v", err)
	}

	if err := AddMcpServer("first", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err != nil {
		t.Fatalf("AddMcpServer on a fresh install: %v", err)
	}

	raw := readRawTestConfig(t, path)
	servers, ok := raw["mcpServers"].(map[string]any)
	if !ok || servers["first"] == nil {
		t.Errorf("server was not written to a newly created engine.json: %#v", raw)
	}
}

// TestAddMcpServer_ReplacesExistingEntry pins that re-adding a name overwrites
// rather than merging: an operator correcting a URL must not be left with the
// old one.
func TestAddMcpServer_ReplacesExistingEntry(t *testing.T) {
	path := seedEngineConfig(t, `{"mcpServers":{"srv":{"type":"http","url":"https://old.example.test/mcp","timeoutSeconds":90}}}`)

	if err := AddMcpServer("srv", types.McpServerConfig{Type: "http", URL: "https://new.example.test/mcp"}); err != nil {
		t.Fatalf("AddMcpServer: %v", err)
	}

	raw := readRawTestConfig(t, path)
	servers := raw["mcpServers"].(map[string]any) //nolint:errcheck // shape asserted above
	entry := servers["srv"].(map[string]any)      //nolint:errcheck // shape asserted above
	if entry["url"] != "https://new.example.test/mcp" {
		t.Errorf("url = %v, want the replacement", entry["url"])
	}
	if _, stale := entry["timeoutSeconds"]; stale {
		t.Error("stale field from the replaced entry survived; the entry must be replaced, not merged")
	}
}

// TestAddMcpServer_MalformedConfigIsRefused pins that a hand-broken engine.json
// is never overwritten. Rewriting it would destroy an operator's in-progress
// edit and their credentials with it.
func TestAddMcpServer_MalformedConfigIsRefused(t *testing.T) {
	path := seedEngineConfig(t, `{"backend": "hybrid", "providers": {`)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	addErr := AddMcpServer("srv", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"})
	if addErr == nil {
		t.Fatal("expected an error for a malformed engine.json")
	}
	if !strings.Contains(addErr.Error(), "valid JSON") {
		t.Errorf("error should explain the file is unparseable, got %q", addErr)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(before) != string(after) {
		t.Error("a malformed engine.json was modified; it must be left untouched")
	}
}

// TestAddMcpServer_NonObjectMcpServersIsRefused pins the same protection for a
// wrongly-typed mcpServers key.
func TestAddMcpServer_NonObjectMcpServersIsRefused(t *testing.T) {
	seedEngineConfig(t, `{"mcpServers": ["not", "an", "object"]}`)

	err := AddMcpServer("srv", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"})
	if err == nil {
		t.Fatal("expected an error when mcpServers is not an object")
	}
	if !strings.Contains(err.Error(), "not an object") {
		t.Errorf("error should name the shape problem, got %q", err)
	}
}

func TestAddMcpServer_RejectsInvalidNames(t *testing.T) {
	cases := map[string]string{
		"empty":           "",
		"whitespace only": "   ",
		"inner space":     "my server",
		"tool separator":  "my__server",
		"leading space":   " srv",
	}
	for label, name := range cases {
		t.Run(label, func(t *testing.T) {
			seedEngineConfig(t, `{}`)
			err := AddMcpServer(name, types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"})
			if err == nil {
				t.Fatalf("expected %q to be rejected", name)
			}
			var nameErr *McpServerNameError
			if !errors.As(err, &nameErr) {
				t.Errorf("error should be a McpServerNameError, got %T: %v", err, err)
			}
		})
	}
}

func TestRemoveMcpServer_DeletesOnlyItsKey(t *testing.T) {
	path := seedEngineConfig(t, `{
  "backend": "hybrid",
  "mcpServers": {
    "keep": { "type": "stdio", "command": "cat" },
    "drop": { "type": "http", "url": "https://example.test/mcp" }
  }
}`)

	if err := RemoveMcpServer("drop"); err != nil {
		t.Fatalf("RemoveMcpServer: %v", err)
	}

	raw := readRawTestConfig(t, path)
	if raw["backend"] != "hybrid" {
		t.Errorf("unrelated key was disturbed: backend = %v", raw["backend"])
	}
	servers := raw["mcpServers"].(map[string]any) //nolint:errcheck // shape asserted above
	if _, present := servers["drop"]; present {
		t.Error("removed server is still present")
	}
	if _, present := servers["keep"]; !present {
		t.Error("remove deleted the wrong server")
	}
}

// TestRemoveMcpServer_UnknownNameIsAnError pins that a typo is reported rather
// than silently succeeding — a consumer told "removed" when nothing changed has
// been lied to.
func TestRemoveMcpServer_UnknownNameIsAnError(t *testing.T) {
	seedEngineConfig(t, `{"mcpServers":{"srv":{"type":"http","url":"https://example.test/mcp"}}}`)

	err := RemoveMcpServer("nonexistent")
	if err == nil {
		t.Fatal("expected an error when removing a server that is not configured")
	}
	if !strings.Contains(err.Error(), "nonexistent") {
		t.Errorf("error should name the server, got %q", err)
	}
}

func TestRemoveMcpServer_NoServersConfigured(t *testing.T) {
	seedEngineConfig(t, `{"backend":"api"}`)

	if err := RemoveMcpServer("srv"); err == nil {
		t.Error("expected an error when no servers are configured")
	}
}

// TestResolveMcpServers_ReadsCurrentFileContents is the no-restart pin: a
// server written after the process started must be visible to the next resolve.
// A boot-cached config would fail this.
func TestResolveMcpServers_ReadsCurrentFileContents(t *testing.T) {
	seedEngineConfig(t, `{"mcpServers":{}}`)

	if got := ResolveMcpServers(""); len(got) != 0 {
		t.Fatalf("precondition: expected no servers, got %v", got)
	}

	if err := AddMcpServer("added-later", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err != nil {
		t.Fatalf("AddMcpServer: %v", err)
	}

	servers := ResolveMcpServers("")
	entry, ok := servers["added-later"]
	if !ok {
		t.Fatalf("a server added after startup is not visible to ResolveMcpServers: %v", servers)
	}
	if entry.URL != "https://example.test/mcp" || entry.Type != "http" {
		t.Errorf("resolved entry = %+v", entry)
	}
}

// TestResolveMcpServers_ProjectLayerMerges pins that a checked-in
// .ion/engine.json contributes servers on top of the user's.
func TestResolveMcpServers_ProjectLayerMerges(t *testing.T) {
	seedEngineConfig(t, `{"mcpServers":{"user-server":{"type":"stdio","command":"cat"}}}`)

	projectDir := t.TempDir()
	projectIon := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(projectIon, 0o700); err != nil {
		t.Fatalf("mkdir project .ion: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projectIon, "engine.json"),
		[]byte(`{"mcpServers":{"project-server":{"type":"http","url":"https://project.example.test/mcp"}}}`), 0o600); err != nil {
		t.Fatalf("write project config: %v", err)
	}

	servers := ResolveMcpServers(projectDir)
	if _, ok := servers["project-server"]; !ok {
		t.Errorf("project-layer server missing from resolution: %v", servers)
	}
}

// TestCheckMcpServerAllowed_EnterpriseDenylist pins that a policy-blocked add is
// refused up front. Without the pre-check the entry lands on disk and is pruned
// at session start, leaving a config the operator can see but never use.
func TestCheckMcpServerAllowed_EnterpriseDenylist(t *testing.T) {
	seedEngineConfig(t, `{}`)

	entDir := t.TempDir()
	entPath := filepath.Join(entDir, "enterprise.json")
	if err := os.WriteFile(entPath, []byte(`{"mcpDenylist":["forbidden"]}`), 0o600); err != nil {
		t.Fatalf("write enterprise config: %v", err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", entPath)

	err := AddMcpServer("forbidden", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"})
	if err == nil {
		t.Fatal("expected a denylisted server to be refused")
	}
	if !strings.Contains(err.Error(), "enterprise policy") {
		t.Errorf("error should name enterprise policy, got %q", err)
	}

	// And nothing was written.
	if servers := ResolveMcpServers(""); len(servers) != 0 {
		t.Errorf("a refused server was written to disk: %v", servers)
	}
}

// TestCheckMcpServerAllowed_EnterpriseAllowlistByName pins the allowlist path,
// including that a non-listed name is refused.
func TestCheckMcpServerAllowed_EnterpriseAllowlistByName(t *testing.T) {
	seedEngineConfig(t, `{}`)

	entDir := t.TempDir()
	entPath := filepath.Join(entDir, "enterprise.json")
	if err := os.WriteFile(entPath, []byte(`{"mcpAllowlist":["sanctioned"]}`), 0o600); err != nil {
		t.Fatalf("write enterprise config: %v", err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", entPath)

	if err := AddMcpServer("sanctioned", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err != nil {
		t.Errorf("an allowlisted server must be accepted: %v", err)
	}
	if err := AddMcpServer("unsanctioned", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err == nil {
		t.Error("a non-allowlisted server must be refused")
	}
}

// TestCheckMcpServerAllowed_EnterpriseAllowlistByURLHost pins the host-glob
// path, which is what closes the rename bypass: the pre-check must accept a
// server whose NAME is not listed but whose URL host matches, exactly as the
// merge-time enforcement does. A name-only pre-check would refuse adds that
// policy actually permits.
func TestCheckMcpServerAllowed_EnterpriseAllowlistByURLHost(t *testing.T) {
	seedEngineConfig(t, `{}`)

	entDir := t.TempDir()
	entPath := filepath.Join(entDir, "enterprise.json")
	if err := os.WriteFile(entPath, []byte(`{"mcpAllowlist":["*.corp.example.test"]}`), 0o600); err != nil {
		t.Fatalf("write enterprise config: %v", err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", entPath)

	if err := AddMcpServer("any-name", types.McpServerConfig{
		Type: "http", URL: "https://tools.corp.example.test/mcp",
	}); err != nil {
		t.Errorf("a server whose URL host matches the allowlist must be accepted: %v", err)
	}

	if err := AddMcpServer("other", types.McpServerConfig{
		Type: "http", URL: "https://elsewhere.example.test/mcp",
	}); err == nil {
		t.Error("a server whose host does not match must be refused")
	}
}

// TestCheckMcpServerAllowed_NoEnterprisePolicy pins that the common case (no
// MDM) permits everything.
func TestCheckMcpServerAllowed_NoEnterprisePolicy(t *testing.T) {
	seedEngineConfig(t, `{}`)
	t.Setenv("ION_ENTERPRISE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))

	if err := CheckMcpServerAllowed("anything", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err != nil {
		t.Errorf("with no enterprise policy every server is permitted, got %v", err)
	}
}

// TestWriteRawConfig_FileModeIsOwnerOnly pins that a config carrying provider
// credentials is not written world-readable.
func TestWriteRawConfig_FileModeIsOwnerOnly(t *testing.T) {
	path := seedEngineConfig(t, `{}`)

	if err := AddMcpServer("srv", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err != nil {
		t.Fatalf("AddMcpServer: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("engine.json mode = %o, want 600; it holds provider credentials", perm)
	}
}

// TestWriteRawConfig_LeavesNoTempFile pins cleanup: a stray engine.json.tmp
// would confuse an operator inspecting ~/.ion.
func TestWriteRawConfig_LeavesNoTempFile(t *testing.T) {
	path := seedEngineConfig(t, `{}`)

	if err := AddMcpServer("srv", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err != nil {
		t.Fatalf("AddMcpServer: %v", err)
	}

	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("temp file survived the write (stat err = %v)", err)
	}
}
