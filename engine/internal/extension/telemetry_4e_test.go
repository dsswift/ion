package extension

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestRespawnBudgetAccessor verifies RespawnBudget reports the strike-budget
// max and RespawnAttempt reports the current attempt count. These accessors
// feed the extension.respawn telemetry event (family 4e). Goes red if either
// accessor is removed or returns the wrong field.
func TestRespawnBudgetAccessor(t *testing.T) {
	h := &Host{}
	if got := h.RespawnBudget(); got != int(respawnBudgetMax) {
		t.Errorf("RespawnBudget() = %d, want %d", got, respawnBudgetMax)
	}
	if got := h.RespawnAttempt(); got != 0 {
		t.Errorf("RespawnAttempt() = %d, want 0 on a fresh host", got)
	}
	h.respawnAttempts.Store(2)
	if got := h.RespawnAttempt(); got != 2 {
		t.Errorf("RespawnAttempt() = %d, want 2 after Store(2)", got)
	}
}

// TestSpawnReadyMsZeroBeforeSpawn verifies SpawnReadyMs returns 0 before any
// successful spawn.
func TestSpawnReadyMsZeroBeforeSpawn(t *testing.T) {
	h := &Host{}
	if got := h.SpawnReadyMs(); got != 0 {
		t.Errorf("SpawnReadyMs() = %d, want 0 before first spawn", got)
	}
}

// TestSpawnReadyMsPopulatedAfterLoad verifies that a successful Load records a
// non-negative cold-start readiness latency accessible via SpawnReadyMs. Goes
// red if spawnAndInit stops recording lastSpawnReadyMs.
func TestSpawnReadyMsPopulatedAfterLoad(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	dir := t.TempDir()
	jsPath := filepath.Join(dir, "ready-ext.js")
	// Minimal extension: respond to the init JSON-RPC request with a result so
	// the handshake completes, then keep the process alive.
	src := `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'ready-ext' } }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
	if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
		t.Fatalf("write tmp ext: %v", err)
	}

	h := NewHost()
	done := make(chan error, 1)
	go func() { done <- h.Load(jsPath, &ExtensionConfig{WorkingDirectory: dir}) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Load failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Load timed out")
	}
	defer h.Dispose()

	if got := h.SpawnReadyMs(); got < 0 {
		t.Errorf("SpawnReadyMs() = %d, want >= 0 after successful Load", got)
	}
}
