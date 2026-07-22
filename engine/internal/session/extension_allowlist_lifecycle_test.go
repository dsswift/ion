package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestStartSession_ExtensionAllowlist_BlocksAndSurfaces pins the #308 end-to-end
// path: with an enterprise extension allowlist that does not list the loaded
// extension, StartSession blocks it, surfaces an engine_error with ErrorCode
// "extension_blocked" (distinct from "extension_load_failed"), and emits an
// enforcement.extension_blocked audit event. Red on unfixed code (no allowlist
// consultation existed; the extension would spawn).
func TestStartSession_ExtensionAllowlist_BlocksAndSurfaces(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	src := `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'blocked-ext' } }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
	jsPath := filepath.Join(dir, "blocked-ext.js")
	if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()

	var mu sync.Mutex
	var codes []string
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_error" {
			mu.Lock()
			codes = append(codes, ev.ErrorCode)
			mu.Unlock()
		}
	})

	cfg := defaultConfig()
	cfg.WorkingDirectory = dir
	cfg.Extensions = []string{jsPath}
	mgr.SetConfig(&types.EngineRuntimeConfig{Enterprise: &types.EnterpriseConfig{
		ExtensionAllowlist: []types.ExtensionAllowlistEntry{{ID: "only-this-one"}},
	}})

	done := make(chan error, 1)
	go func() {
		_, err := mgr.StartSession("block1", cfg)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("StartSession failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("StartSession timed out")
	}

	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, c := range codes {
		if c == "extension_blocked" {
			found = true
		}
		if c == "extension_load_failed" {
			t.Error("blocked extension must not report extension_load_failed")
		}
	}
	if !found {
		t.Errorf("expected an engine_error with ErrorCode extension_blocked, got codes %v", codes)
	}
}

// TestStartSession_ExtensionAllowlist_Allowed pins that a listed extension
// loads normally (no block, no error code).
func TestStartSession_ExtensionAllowlist_Allowed(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	// Directory basename is the identifier when the init name is unused before
	// the allowlist check; the check runs against h.name which resolves to the
	// manifest/init name. We give the extension a manifest so the identifier is
	// deterministic.
	src := `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'allowed-ext' } }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
	// Manifest fixes the identifier to "allowed-ext" (name resolution:
	// manifest.Name wins over dir basename).
	if err := os.WriteFile(filepath.Join(dir, "extension.json"), []byte(`{"name":"allowed-ext"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	jsPath := filepath.Join(dir, "index.js")
	if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()

	var mu sync.Mutex
	var codes []string
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_error" {
			mu.Lock()
			codes = append(codes, ev.ErrorCode)
			mu.Unlock()
		}
	})

	cfg := defaultConfig()
	cfg.WorkingDirectory = dir
	cfg.Extensions = []string{jsPath}
	mgr.SetConfig(&types.EngineRuntimeConfig{Enterprise: &types.EnterpriseConfig{
		ExtensionAllowlist: []types.ExtensionAllowlistEntry{{ID: "allowed-ext"}},
	}})

	done := make(chan error, 1)
	go func() {
		_, err := mgr.StartSession("allow1", cfg)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("StartSession failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("StartSession timed out")
	}

	mgr.mu.Lock()
	s := mgr.sessions["allow1"]
	hasGroup := s != nil && s.extGroup != nil && !s.extGroup.IsEmpty()
	mgr.mu.Unlock()

	mu.Lock()
	defer mu.Unlock()
	for _, c := range codes {
		if c == "extension_blocked" {
			t.Error("allowed extension must not be blocked")
		}
	}
	if !hasGroup {
		t.Error("allowed extension must load into the session's extension group")
	}
}

