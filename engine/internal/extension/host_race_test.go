package extension

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestCallWithTimeout_DeadChUnblocksMidFlight covers the lost-race window:
// the caller passes the entry h.dead.Load() check while the subprocess is
// still alive, inserts into h.pending, then the subprocess dies. readLoop's
// drain may have already run before the insert, so the pending channel
// would never be closed. The deadCh select arm guarantees the call fails
// fast (~ms) instead of blocking the full rpcCallTimeout.
func TestCallWithTimeout_DeadChUnblocksMidFlight(t *testing.T) {
	h := &Host{}
	h.pending = make(map[int64]chan *jsonrpcResponse)
	h.deadCh = make(chan struct{})
	h.deadOnce = &sync.Once{}

	pr, pw := io.Pipe()
	defer pr.Close()
	h.stdin = pw
	go io.Copy(io.Discard, pr)

	go func() {
		time.Sleep(20 * time.Millisecond)
		h.dead.Store(true)
		h.signalDead()
	}()

	start := time.Now()
	_, err := h.callWithTimeout("init", nil, 5*time.Second)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "died during init") {
		t.Fatalf("expected 'died during init' error, got %v", err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("call did not fail fast: elapsed=%v (timeout would have been 5s)", elapsed)
	}

	h.pendMu.Lock()
	leftover := len(h.pending)
	h.pendMu.Unlock()
	if leftover != 0 {
		t.Fatalf("pending map not drained: %d entries remain", leftover)
	}
}

// TestHostLoad_FailsFastWhenSubprocessExitsImmediately is the end-to-end
// regression test for the chief-of-staff scenario: a Node child that exits
// before responding to init must cause Load() to return promptly with an
// error, not hang for 30 seconds. With the deadCh fix in place this should
// complete in well under a second; without it, the test would time out at
// the rpcCallTimeout.
func TestHostLoad_FailsFastWhenSubprocessExitsImmediately(t *testing.T) {
	if _, err := os.Stat("/usr/bin/env"); err != nil {
		t.Skip("/usr/bin/env not available")
	}

	dir := t.TempDir()
	jsPath := filepath.Join(dir, "exit-fast.js")
	// .js so host.go's spawnAndInit picks the node path. Process exits
	// immediately on import — no init response will arrive.
	if err := os.WriteFile(jsPath, []byte("process.exit(0);\n"), 0o644); err != nil {
		t.Fatalf("write tmp ext: %v", err)
	}

	h := NewHost()

	done := make(chan error, 1)
	go func() {
		done <- h.Load(jsPath, &ExtensionConfig{WorkingDirectory: dir})
	}()

	start := time.Now()
	select {
	case err := <-done:
		elapsed := time.Since(start)
		t.Logf("Load returned in %v with err=%v", elapsed, err)
		if err == nil {
			t.Fatal("expected Load() to error when subprocess exits before init")
		}
		if elapsed > 5*time.Second {
			t.Fatalf("Load took %v — race fix regressed (was 30s)", elapsed)
		}
	case <-time.After(35 * time.Second):
		t.Fatal("Load() did not return within 35s — completely hung")
	}
}
