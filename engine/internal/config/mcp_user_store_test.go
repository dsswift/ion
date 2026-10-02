package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

const managedEngineWithMcp = `{"mcpServers":{"managed-server":{"command":"managed-cmd"}}}`

// useManagedEngine projects a managed engine file that defines one MCP
// server, with policy applied on top of the managedConfig block.
func useManagedEngine(t *testing.T, policy types.EnterpriseConfig, disableUserMcp bool) managedFixture {
	t.Helper()
	f := newManagedFixture(t, userGlobalEngine, "{}")
	path := f.managed(t, "engine.managed.json", managedEngineWithMcp)
	policy.ManagedConfig = &types.ManagedConfigSource{EnginePath: path, SchemaVersion: 1, DisableUserMcpServers: disableUserMcp}
	useMachinePolicy(t, policy)
	return f
}

func (f managedFixture) userMcpStore() string {
	return filepath.Join(f.home, ".ion", "mcp", "servers.json")
}

func TestUserMcpStore_UserServersJoinTheManagedOnes(t *testing.T) {
	f := useManagedEngine(t, types.EnterpriseConfig{}, false)

	if err := AddMcpServer("mine", types.McpServerConfig{Command: "my-cmd"}); err != nil {
		t.Fatalf("AddMcpServer: %v", err)
	}
	servers := ResolveMcpServers(f.projectDir)
	if len(servers) != 2 || servers["mine"].Command != "my-cmd" || servers["managed-server"].Command != "managed-cmd" {
		t.Fatalf("ResolveMcpServers = %v, want the managed server and the user's", servers)
	}
	// The server landed in the user's own file, owner-only, and engine.json
	// (which a managed surface does not read) was left alone.
	info, err := os.Stat(f.userMcpStore())
	if err != nil {
		t.Fatalf("user mcp store: %v", err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		t.Errorf("user mcp store mode = %o, want owner-only", perm)
	}
	if data, _ := os.ReadFile(filepath.Join(f.home, ".ion", "engine.json")); string(data) != userGlobalEngine {
		t.Errorf("global engine.json changed: %s", data)
	}
	if names := ManagedMcpServerNames(); len(names) != 1 || !names["managed-server"] {
		t.Errorf("ManagedMcpServerNames = %v, want only managed-server", names)
	}

	result, err := UpdateMcpServer("mine", McpServerPatch{Command: "my-new-cmd"})
	if err != nil || !result.Changed {
		t.Fatalf("UpdateMcpServer = %+v, %v", result, err)
	}
	if got := ResolveMcpServers(f.projectDir)["mine"].Command; got != "my-new-cmd" {
		t.Errorf("updated command = %q", got)
	}
	if err := RemoveMcpServer("mine"); err != nil {
		t.Fatalf("RemoveMcpServer: %v", err)
	}
	if servers := ResolveMcpServers(f.projectDir); len(servers) != 1 {
		t.Errorf("ResolveMcpServers after remove = %v, want only the managed server", servers)
	}
}

func TestUserMcpStore_ManagedServersCannotBeChanged(t *testing.T) {
	f := useManagedEngine(t, types.EnterpriseConfig{}, false)
	// A hand-edited user file that tries to replace the managed server.
	f.write(t, f.userMcpStore(), `{"mcpServers":{"managed-server":{"command":"hijacked"}}}`)

	if got := ResolveMcpServers(f.projectDir)["managed-server"].Command; got != "managed-cmd" {
		t.Errorf("managed-server command = %q, want the managed file's", got)
	}

	writes := map[string]func() error{
		"mcp_add":    func() error { return AddMcpServer("managed-server", types.McpServerConfig{Command: "x"}) },
		"mcp_remove": func() error { return RemoveMcpServer("managed-server") },
		"mcp_update": func() error {
			_, err := UpdateMcpServer("managed-server", McpServerPatch{Command: "y"})
			return err
		},
	}
	for operation, write := range writes {
		var refused *ManagedMcpServerError
		if err := write(); !errors.As(err, &refused) {
			t.Fatalf("%s error = %v, want a ManagedMcpServerError", operation, err)
		}
		if refused.Name != "managed-server" || refused.Operation != operation || refused.ResultCode() != ManagedConfigWriteRefusedCode {
			t.Errorf("%s refusal = %+v", operation, refused)
		}
	}
}

func TestUserMcpStore_CarriesOnlyMcpServers(t *testing.T) {
	f := useManagedEngine(t, types.EnterpriseConfig{}, false)
	f.write(t, f.userMcpStore(), `{"defaultModel":"smuggled-model","limits":{"maxTurns":9},"mcpServers":{"mine":{"command":"my-cmd"}}}`)

	cfg := mergeConfigLayers(f.projectDir)
	if cfg.DefaultModel != "" || cfg.Limits.MaxTurns != nil {
		t.Errorf("DefaultModel=%q MaxTurns=%v, want neither: the user mcp file carries only servers", cfg.DefaultModel, cfg.Limits.MaxTurns)
	}
	if cfg.McpServers["mine"].Command != "my-cmd" {
		t.Errorf("McpServers = %v, want the user's server", cfg.McpServers)
	}
}

func TestUserMcpStore_EnterpriseListsStillApply(t *testing.T) {
	f := useManagedEngine(t, types.EnterpriseConfig{McpDenylist: []string{"blocked"}}, false)
	f.write(t, f.userMcpStore(), `{"mcpServers":{"blocked":{"command":"x"},"mine":{"command":"my-cmd"}}}`)

	servers := ResolveMcpServers(f.projectDir)
	if _, present := servers["blocked"]; present {
		t.Errorf("ResolveMcpServers = %v, want the denylisted user server pruned", servers)
	}
	if _, present := servers["mine"]; !present {
		t.Errorf("ResolveMcpServers = %v, want the permitted user server kept", servers)
	}
	if err := AddMcpServer("blocked", types.McpServerConfig{Command: "x"}); err == nil {
		t.Error("AddMcpServer(blocked) = nil, want the denylist refusal")
	}
}

func TestUserMcpStore_DisabledByPolicy(t *testing.T) {
	f := useManagedEngine(t, types.EnterpriseConfig{}, true)
	const stored = `{"mcpServers":{"mine":{"command":"my-cmd"}}}`
	f.write(t, f.userMcpStore(), stored)
	_ = DrainEnforcementActions() // clear residue

	if servers := ResolveMcpServers(f.projectDir); len(servers) != 1 || servers["managed-server"].Command != "managed-cmd" {
		t.Fatalf("ResolveMcpServers = %v, want only the managed server", servers)
	}

	writes := map[string]func() error{
		"mcp_add":    func() error { return AddMcpServer("other", types.McpServerConfig{Command: "x"}) },
		"mcp_remove": func() error { return RemoveMcpServer("mine") },
		"mcp_update": func() error {
			_, err := UpdateMcpServer("mine", McpServerPatch{Command: "y"})
			return err
		},
	}
	for operation, write := range writes {
		var refused *ManagedConfigWriteError
		if err := write(); !errors.As(err, &refused) {
			t.Fatalf("%s error = %v, want a ManagedConfigWriteError", operation, err)
		}
		if refused.Surface != ManagedSurfaceEngine || refused.Operation != operation {
			t.Errorf("%s refusal = %+v", operation, refused)
		}
	}
	if data, _ := os.ReadFile(f.userMcpStore()); string(data) != stored {
		t.Errorf("user mcp store changed: %s", data)
	}
	if refusals := DrainEnforcementActions(); len(refusals) != len(writes) {
		t.Errorf("recorded %d write refusals, want %d", len(refusals), len(writes))
	}
}

func TestUserMcpStore_UnappliedManagedFileRefusesWrites(t *testing.T) {
	f := newManagedFixture(t, userGlobalEngine, "{}")
	useMachinePolicy(t, types.EnterpriseConfig{
		ManagedConfig: &types.ManagedConfigSource{EnginePath: filepath.Join(f.managedDir, "absent.json"), SchemaVersion: 1},
	})
	f.write(t, f.userMcpStore(), `{"mcpServers":{"mine":{"command":"my-cmd"}}}`)

	if servers := ResolveMcpServers(f.projectDir); len(servers) != 0 {
		t.Errorf("ResolveMcpServers = %v, want none while the managed file is not applied", servers)
	}
	var refused *ManagedConfigWriteError
	if err := AddMcpServer("other", types.McpServerConfig{Command: "x"}); !errors.As(err, &refused) {
		t.Fatalf("AddMcpServer error = %v, want a ManagedConfigWriteError", err)
	}
}

func TestUserMcpStore_UnmanagedSurfaceKeepsEngineJSON(t *testing.T) {
	f := newManagedFixture(t, "{}", "{}")
	useMachinePolicy(t, types.EnterpriseConfig{})

	if err := AddMcpServer("mine", types.McpServerConfig{Command: "my-cmd"}); err != nil {
		t.Fatalf("AddMcpServer: %v", err)
	}
	if _, err := os.Stat(f.userMcpStore()); !os.IsNotExist(err) {
		t.Errorf("user mcp store exists (stat err %v), want engine.json to be the target", err)
	}
	if got := ResolveMcpServers(f.projectDir)["mine"].Command; got != "my-cmd" {
		t.Errorf("mine command = %q, want it read from engine.json", got)
	}
	if names := ManagedMcpServerNames(); len(names) != 0 {
		t.Errorf("ManagedMcpServerNames = %v, want none", names)
	}
}
