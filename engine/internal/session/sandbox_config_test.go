package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestBuildSandboxConfig_NilWhenNeitherLayerEnables(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{})

	if cfg := buildSandboxConfig(mgr, nil); cfg != nil {
		t.Errorf("expected nil sandbox config with neither user nor enterprise sandbox enabled, got %+v", cfg)
	}
}

func TestBuildSandboxConfig_UserEnabledPopulatesFields(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{
			Sandbox: &types.SandboxConfig{
				Enabled:    boolPtr(true),
				DenyRead:   []string{"/etc/secrets"},
				AllowWrite: []string{"/tmp"},
			},
		},
	})

	cfg := buildSandboxConfig(mgr, nil)
	if cfg == nil {
		t.Fatal("expected a non-nil sandbox config once the user layer enables it")
	}
	if len(cfg.Filesystem.DenyRead) != 1 || cfg.Filesystem.DenyRead[0] != "/etc/secrets" {
		t.Errorf("DenyRead = %v, want [/etc/secrets]", cfg.Filesystem.DenyRead)
	}
	if len(cfg.Filesystem.AllowWrite) != 1 || cfg.Filesystem.AllowWrite[0] != "/tmp" {
		t.Errorf("AllowWrite = %v, want [/tmp]", cfg.Filesystem.AllowWrite)
	}
}

func TestBuildSandboxConfig_EnterpriseRequiredForcesOnEvenWithUserDisabled(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{Sandbox: &types.SandboxConfig{Enabled: boolPtr(false)}},
		Enterprise: &types.EnterpriseConfig{
			Sandbox: &types.SandboxEnterpriseConfig{Required: true, AdditionalDenyPaths: []string{"/secure"}},
		},
	})

	cfg := buildSandboxConfig(mgr, nil)
	if cfg == nil {
		t.Fatal("expected the enterprise Required seal to force the sandbox on regardless of the user setting")
	}
	if len(cfg.Filesystem.DenyRead) != 1 || cfg.Filesystem.DenyRead[0] != "/secure" {
		t.Errorf("expected the enterprise AdditionalDenyPaths applied, got %v", cfg.Filesystem.DenyRead)
	}
}

func TestBuildSandboxConfig_PartitioningAddsDenyWithOwnPartitionException(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	conversation.ConfigurePartitioning(conversation.DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true})
	t.Cleanup(conversation.ResetPartitioningForTest)

	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{Sandbox: &types.SandboxConfig{Enabled: boolPtr(true)}},
	})

	alice := &types.SessionPrincipal{Subject: "oidc:alice"}
	cfg := buildSandboxConfig(mgr, alice)
	if cfg == nil {
		t.Fatal("expected a non-nil sandbox config")
	}

	ownDir := conversation.PartitionConversationsDir("oidc:alice")
	found := false
	for _, p := range cfg.Filesystem.AllowRead {
		if p != "" && ownDir != "" && len(p) > 0 && p == ownDir[:len(ownDir)-len("/conversations")] {
			found = true
		}
	}
	if !found {
		t.Errorf("expected AllowRead to carve out alice's own partition, got %v", cfg.Filesystem.AllowRead)
	}
	if len(cfg.Filesystem.DenyRead) == 0 {
		t.Error("expected DenyRead populated with the principals root and flat root once partitioning is active")
	}
}

func TestBuildSandboxConfig_UnattributedSessionGetsNoPartitioningDeny(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	conversation.ConfigurePartitioning(conversation.DefaultConversationsDir(), &types.PrincipalPartitioningConfig{Enabled: true})
	t.Cleanup(conversation.ResetPartitioningForTest)

	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{Sandbox: &types.SandboxConfig{Enabled: boolPtr(true)}},
	})

	cfg := buildSandboxConfig(mgr, nil)
	if cfg == nil {
		t.Fatal("expected a non-nil sandbox config (user layer enabled it)")
	}
	if len(cfg.Filesystem.DenyRead) != 0 {
		t.Errorf("expected no partitioning-related deny for an unattributed session, got %v", cfg.Filesystem.DenyRead)
	}
}
