package server

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// dispatchForResult runs one command and returns the ServerResult it wrote.
func dispatchForResult(t *testing.T, s *Server, cmd *protocol.ClientCommand) protocol.ServerResult {
	t.Helper()
	client, server := net.Pipe()
	t.Cleanup(func() {
		client.Close() //nolint:errcheck // test pipe teardown
		server.Close() //nolint:errcheck // test pipe teardown
	})
	resultCh := make(chan protocol.ServerResult, 1)
	go func() { resultCh <- readListModelsResult(t, client) }()
	s.dispatch(server, cmd)
	return <-resultCh
}

// seedCustomProvider writes engine.json with one custom provider, stores its
// key, and registers it the way boot does.
func seedCustomProvider(t *testing.T, engineJSON string) (*Server, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	path := filepath.Join(home, ".ion", "engine.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(engineJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := map[string]types.ProviderConfig{"corp-gateway": {BaseURL: "https://gw.example.org/v1", DisplayName: "Corp"}}
	providers.ApplyConfig(cfg)
	t.Cleanup(func() { providers.ForgetProvider("corp-gateway"); providers.ResetDiscoveryCache() })
	if err := auth.NewFileStore().SetKey("corp-gateway", "sk-test"); err != nil {
		t.Fatal(err)
	}
	return &Server{authResolver: auth.NewResolver(nil), config: &types.EngineRuntimeConfig{Providers: cfg}}, path
}

func TestProviderRemove_RemovesACustomProviderEverywhere(t *testing.T) {
	s, path := seedCustomProvider(t, `{"providers":{"corp-gateway":{"baseURL":"https://gw.example.org/v1"}}}`)
	if entries := s.buildProviderEntries(nil); !hasCustomEntry(entries, "corp-gateway") {
		t.Fatal("setup: corp-gateway should be listed as a custom provider")
	}

	res := dispatchForResult(t, s, &protocol.ClientCommand{Cmd: "provider_remove", Provider: "corp-gateway", RequestID: "r1"})
	if !res.OK {
		t.Fatalf("provider_remove failed: %s", res.Error)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "corp-gateway") {
		t.Errorf("engine.json still names the provider: %s", data)
	}
	if key, _ := auth.NewFileStore().GetKey("corp-gateway"); key != "" { //nolint:errcheck // an absent key is the expectation
		t.Error("the stored key survived the removal")
	}
	for _, e := range s.buildProviderEntries(nil) {
		if e.ID == "corp-gateway" {
			t.Fatal("list_models still lists the removed provider")
		}
	}
	if _, still := s.providerConfigs()["corp-gateway"]; still {
		t.Error("the removed provider is still in the provider configs in force")
	}
}

func TestProviderRemove_RefusesABuiltinProvider(t *testing.T) {
	s, _ := seedCustomProvider(t, `{"providers":{"anthropic":{"backend":"api"}}}`)
	res := dispatchForResult(t, s, &protocol.ClientCommand{Cmd: "provider_remove", Provider: "anthropic", RequestID: "r1"})
	if res.OK || !strings.Contains(res.Error, "built in") {
		t.Fatalf("want a built-in refusal, got ok=%v error=%q", res.OK, res.Error)
	}
}

// The engine.json defaultModel is only the engine's fallback; the default a
// person picks lives in models.json, and only that one blocks a removal.
func TestProviderRemove_ClearsTheEngineFallbackButNotAModelsJSONDefault(t *testing.T) {
	s, path := seedCustomProvider(t, `{"defaultModel":"corp-gateway/model-a","providers":{"corp-gateway":{"baseURL":"https://gw.example.org/v1"}}}`)
	modelsJSON := filepath.Join(filepath.Dir(path), "models.json")
	if err := os.WriteFile(modelsJSON, []byte(`{"defaultModel":"corp-gateway/model-a","tiers":{"standard":"claude-sonnet-5-5"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	res := dispatchForResult(t, s, &protocol.ClientCommand{Cmd: "provider_remove", Provider: "corp-gateway", RequestID: "r1"})
	if res.OK || !strings.Contains(res.Error, "the default model corp-gateway/model-a") {
		t.Fatalf("want a models.json refusal, got ok=%v error=%q", res.OK, res.Error)
	}
	if data, _ := os.ReadFile(path); !strings.Contains(string(data), `"corp-gateway"`) { //nolint:errcheck // the content check covers a failed read
		t.Error("a refused removal changed engine.json")
	}
	if key, _ := auth.NewFileStore().GetKey("corp-gateway"); key == "" { //nolint:errcheck // a missing key fails the check
		t.Error("a refused removal deleted the stored key")
	}
	if providers.GetProvider("corp-gateway") == nil {
		t.Error("a refused removal unregistered the provider")
	}

	if err := os.WriteFile(modelsJSON, []byte(`{"defaultModel":"claude-opus-5-5","defaultProvider":"anthropic"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	res = dispatchForResult(t, s, &protocol.ClientCommand{Cmd: "provider_remove", Provider: "corp-gateway", RequestID: "r2"})
	if !res.OK {
		t.Fatalf("provider_remove failed: %s", res.Error)
	}
	data, ok := res.Data.(map[string]any)
	if !ok || data["clearedFallbackModel"] != "corp-gateway/model-a" {
		t.Errorf("result data = %v, want the cleared fallback named", res.Data)
	}
	if raw, _ := os.ReadFile(path); strings.Contains(string(raw), "corp-gateway") { //nolint:errcheck // the content check covers a failed read
		t.Errorf("engine.json still names the provider or its fallback: %s", raw)
	}
}

func hasCustomEntry(entries []types.ProviderEntry, id string) bool {
	for _, e := range entries {
		if e.ID == id {
			return e.Custom
		}
	}
	return false
}
