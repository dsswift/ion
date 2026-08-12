package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func writeBuildIdentityExtension(t *testing.T, dir, identity string) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	source := `
const expected = process.env.ION_TEST_BUILD_IDENTITY;
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  if (message.id === undefined || message.id === null) return;
  if (message.method === 'init') {
    const received = message.params && message.params.buildIdentity;
    const buildIdentity = received === expected ? expected : 'wrong-config-identity';
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: { name: 'build-identity-test', buildIdentity }
    }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
	path := filepath.Join(dir, "build-identity-extension.js")
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write extension: %v", err)
	}
	t.Setenv("ION_TEST_BUILD_IDENTITY", identity)
	return path
}

func requireLoadedBuildIdentityHost(t *testing.T, mgr *Manager, key, want string) {
	t.Helper()
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()

	s := mgr.sessions[key]
	if s == nil || s.extGroup == nil || s.extGroup.IsEmpty() {
		t.Fatal("expected loaded extension host")
	}
	hosts := s.extGroup.Hosts()
	if len(hosts) != 1 {
		t.Fatalf("loaded hosts = %d, want 1", len(hosts))
	}
	if got := hosts[0].EngineBuildIdentity(); got != want {
		t.Errorf("host build identity = %q, want %q", got, want)
	}
}

func TestManagerBuildIdentity_AccessorUsesManagerSnapshot(t *testing.T) {
	mgr := NewManager(newMockBackend())
	defer mgr.Shutdown()

	const identity = "manager-build-identity"
	mgr.SetEngineBuildIdentity(identity)

	accessor := &sessionAccessor{m: mgr}
	if got := accessor.EngineBuildIdentity(); got != identity {
		t.Errorf("accessor build identity = %q, want %q", got, identity)
	}
}

func TestManagerBuildIdentity_StartupAndPerPromptHosts(t *testing.T) {
	const identity = "manager-build-identity"

	t.Run("startup", func(t *testing.T) {
		dir := t.TempDir()
		extensionPath := writeBuildIdentityExtension(t, dir, identity)
		mgr := NewManager(newMockBackend())
		defer mgr.Shutdown()
		mgr.SetEngineBuildIdentity(identity)

		config := defaultConfig()
		config.WorkingDirectory = dir
		config.Extensions = []string{extensionPath}
		if _, err := mgr.StartSession("startup-build-identity", config); err != nil {
			t.Fatalf("StartSession: %v", err)
		}
		requireLoadedBuildIdentityHost(t, mgr, "startup-build-identity", identity)
	})

	t.Run("per prompt", func(t *testing.T) {
		dir := t.TempDir()
		extensionPath := writeBuildIdentityExtension(t, dir, identity)
		mgr := NewManager(newMockBackend())
		defer mgr.Shutdown()
		mgr.SetEngineBuildIdentity(identity)

		config := defaultConfig()
		config.WorkingDirectory = dir
		if _, err := mgr.StartSession("per-prompt-build-identity", config); err != nil {
			t.Fatalf("StartSession: %v", err)
		}

		mgr.mu.RLock()
		s := mgr.sessions["per-prompt-build-identity"]
		mgr.mu.RUnlock()
		if s == nil {
			t.Fatal("session not found")
		}
		mgr.lateLoadExtensions(s, "per-prompt-build-identity", &PromptOverrides{
			Extensions: []string{extensionPath},
		})
		requireLoadedBuildIdentityHost(t, mgr, "per-prompt-build-identity", identity)
	})
}
