package session

import (
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
)

func railTestSession(t *testing.T, b backend.RunBackend) (*Manager, *engineSession) {
	t.Helper()
	mgr := NewManager(b)
	s := &engineSession{}
	mgr.mu.Lock()
	mgr.sessions["rail"] = s
	mgr.mu.Unlock()
	t.Cleanup(func() {
		if s.permHookServer != nil {
			s.permHookServer.Close()
		}
		if s.hookSettingsPath != "" {
			os.Remove(s.hookSettingsPath)
		}
	})
	return mgr, s
}

// One hook server and one settings file serve every prompt of a session. A
// server per prompt leaks a listener each time.
func TestWirePermissionHookServer_OnePerSession(t *testing.T) {
	mgr, s := railTestSession(t, backend.NewClaudeCodeBackend())
	permEng := permissions.NewEngine(&permissions.DefaultPolicy)

	first := types.RunOptions{}
	if err := mgr.wirePermissionHookServer(s, "rail", &first, permEng); err != nil {
		t.Fatalf("first prompt: %v", err)
	}
	server := s.permHookServer
	if server == nil || first.HookSettingsPath == "" {
		t.Fatalf("first prompt must start the rail: server=%v settings=%q", server, first.HookSettingsPath)
	}
	if _, err := os.Stat(first.HookSettingsPath); err != nil {
		t.Fatalf("settings file not written: %v", err)
	}

	second := types.RunOptions{}
	if err := mgr.wirePermissionHookServer(s, "rail", &second, permEng); err != nil {
		t.Fatalf("second prompt: %v", err)
	}
	if s.permHookServer != server {
		t.Fatal("a second prompt started a second hook server")
	}
	if second.HookSettingsPath != first.HookSettingsPath {
		t.Fatalf("settings path changed between prompts: %q then %q", first.HookSettingsPath, second.HookSettingsPath)
	}
}

// A run with no rail executes every tool unchecked, so a rail that cannot be
// set up must stop the prompt.
func TestWirePermissionHookServer_FailsThePromptWithoutARail(t *testing.T) {
	t.Run("no permission engine", func(t *testing.T) {
		mgr, s := railTestSession(t, backend.NewClaudeCodeBackend())
		opts := types.RunOptions{}
		if err := mgr.wirePermissionHookServer(s, "rail", &opts, nil); err == nil {
			t.Fatal("want an error when the session has no permission engine")
		}
	})

	t.Run("settings file cannot be written", func(t *testing.T) {
		t.Setenv("TMPDIR", "/nonexistent-ion-rail-test-dir")
		mgr, s := railTestSession(t, backend.NewClaudeCodeBackend())
		opts := types.RunOptions{}
		err := mgr.wirePermissionHookServer(s, "rail", &opts, permissions.NewEngine(&permissions.DefaultPolicy))
		if err == nil {
			t.Fatal("want an error when the settings file cannot be written")
		}
		if s.permHookServer != nil || opts.HookSettingsPath != "" {
			t.Fatal("a failed setup must leave no half-wired rail behind")
		}
	})
}

// The API backend enforces permissions in-process and takes no hook server.
func TestWirePermissionHookServer_NoopForApiBackend(t *testing.T) {
	mgr, s := railTestSession(t, backend.NewApiBackend())
	opts := types.RunOptions{}
	if err := mgr.wirePermissionHookServer(s, "rail", &opts, nil); err != nil {
		t.Fatalf("api backend: %v", err)
	}
	if s.permHookServer != nil || opts.HookSettingsPath != "" {
		t.Fatal("api backend must not get a hook server")
	}
}
