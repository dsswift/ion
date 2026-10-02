package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestMcpServerStatuses_MarksManagedServers pins that the snapshot tells a
// server the managed engine file defines apart from one the user added.
func TestMcpServerStatuses_MarksManagedServers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	policyDir := t.TempDir()
	managedPath := filepath.Join(policyDir, "engine.managed.json")
	if err := os.WriteFile(managedPath, []byte(`{"mcpServers":{"org":{"command":"org-cmd"}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	policy, err := json.Marshal(types.EnterpriseConfig{
		ManagedConfig: &types.ManagedConfigSource{EnginePath: managedPath, SchemaVersion: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(policyDir, "enterprise.json")
	if err := os.WriteFile(policyPath, policy, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", policyPath)

	userStore := filepath.Join(home, ".ion", "mcp", "servers.json")
	if err := os.MkdirAll(filepath.Dir(userStore), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userStore, []byte(`{"mcpServers":{"mine":{"command":"my-cmd"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	managed := map[string]bool{}
	for _, status := range NewManager(newMockBackend()).McpServerStatuses("") {
		managed[status.Name] = status.Managed
	}
	if len(managed) != 2 || !managed["org"] || managed["mine"] {
		t.Fatalf("managed flags = %v, want org managed and mine not", managed)
	}
}
