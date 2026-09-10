package backend

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
)

func TestWriteToStdinWritesNDJSON(t *testing.T) {
	// Create a pipe to capture what WriteToStdin writes
	pr, pw := io.Pipe()

	run := &claudeCodeRun{
		requestID: "test-run",
		stdinPipe: pw,
		stderr:    rpcstdio.NewRingBuffer(10),
	}

	b := &ClaudeCodeBackend{
		activeRuns: map[string]*claudeCodeRun{"test-run": run},
	}

	msg := map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{
			"role": "user",
			"content": []map[string]interface{}{
				{"type": "text", "text": "follow up message"},
			},
		},
	}

	// Read in background
	var received []byte
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		var buf bytes.Buffer
		io.Copy(&buf, pr)
		received = buf.Bytes()
	}()

	err := b.WriteToStdin("test-run", msg)
	if err != nil {
		t.Fatalf("WriteToStdin failed: %v", err)
	}

	// Close pipe to unblock reader
	pw.Close()
	wg.Wait()

	// Verify NDJSON line
	if len(received) == 0 {
		t.Fatal("no data written to stdin")
	}
	if received[len(received)-1] != '\n' {
		t.Error("expected NDJSON line to end with newline")
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(received[:len(received)-1], &parsed); err != nil {
		t.Fatalf("written data is not valid JSON: %v", err)
	}
	if parsed["type"] != "user" {
		t.Errorf("expected type=user, got %v", parsed["type"])
	}
}

func TestWriteToStdinClosedPipe(t *testing.T) {
	pr, pw := io.Pipe()
	pw.Close()
	pr.Close()

	run := &claudeCodeRun{
		requestID: "closed-run",
		stdinPipe: nil, // already nil
		stderr:    rpcstdio.NewRingBuffer(10),
	}

	b := &ClaudeCodeBackend{
		activeRuns: map[string]*claudeCodeRun{"closed-run": run},
	}

	err := b.WriteToStdin("closed-run", "hello")
	if err == nil {
		t.Fatal("expected error for closed pipe")
	}
}

func TestWriteToStdinRunNotFound(t *testing.T) {
	b := &ClaudeCodeBackend{
		activeRuns: make(map[string]*claudeCodeRun),
	}

	err := b.WriteToStdin("nonexistent", "hello")
	if err == nil {
		t.Fatal("expected error for missing run")
	}
}

func TestCliBackendBuildArgs(t *testing.T) {
	// Test that args construction includes --input-format stream-json.
	// We can't easily spawn a real process, but we can test the arg
	// builder logic by examining the code path indirectly through
	// the findClaudeBinary + arg construction.
	//
	// For now, verify the ClaudeCodeBackend interface is satisfied and
	// the struct fields are present.
	b := NewClaudeCodeBackend()
	if b == nil {
		t.Fatal("NewClaudeCodeBackend returned nil")
	}

	// Verify interface satisfaction
	var _ RunBackend = b
}

// TestCancelBeforeSpawnDoesNotPanic pins the fix for a nil-pointer crash
// observed on Windows CI: StartRun registers the run into activeRuns before
// runProcess (its own goroutine) assigns run.cmd, so a Cancel that lands in
// that window previously dereferenced a nil *exec.Cmd at run.cmd.Process.
// Cancel must treat "no process yet" the same way it already treats "process
// registered but not started" -- cancel the run's context and report success.
func TestCancelBeforeSpawnDoesNotPanic(t *testing.T) {
	cancelled := false
	run := &claudeCodeRun{
		requestID: "test-run",
		cancel:    func() { cancelled = true },
		stderr:    rpcstdio.NewRingBuffer(5),
		// cmd is deliberately nil: the window this test pins.
	}

	b := &ClaudeCodeBackend{
		activeRuns: map[string]*claudeCodeRun{"test-run": run},
	}

	if ok := b.Cancel("test-run"); !ok {
		t.Error("Cancel should report success for a run with no process yet")
	}
	if !cancelled {
		t.Error("Cancel should cancel the run's context when there is no process to signal")
	}
}

func TestCliRunFieldsPresent(t *testing.T) {
	run := &claudeCodeRun{
		requestID: "test",
		stderr:    rpcstdio.NewRingBuffer(5),
	}

	// stdinPipe should default to nil
	if run.stdinPipe != nil {
		t.Error("stdinPipe should be nil by default")
	}

	// stdinMu should be usable (lock/unlock without deadlock)
	run.stdinMu.Lock()
	_ = run.stdinPipe // access guarded field
	run.stdinMu.Unlock()
}
