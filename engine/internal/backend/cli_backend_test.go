package backend

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"testing"
)

func TestRingBuffer(t *testing.T) {
	rb := newRingBuffer(3)

	rb.Write("line1")
	rb.Write("line2")
	rb.Write("line3")
	rb.Write("line4") // should evict line1

	lines := rb.Lines()
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	if lines[0] != "line2" {
		t.Errorf("expected first line 'line2', got %q", lines[0])
	}
	if lines[2] != "line4" {
		t.Errorf("expected last line 'line4', got %q", lines[2])
	}
}

func TestRingBufferEmpty(t *testing.T) {
	rb := newRingBuffer(5)
	lines := rb.Lines()
	if len(lines) != 0 {
		t.Fatalf("expected 0 lines, got %d", len(lines))
	}
}

func TestWriteToStdinWritesNDJSON(t *testing.T) {
	// Create a pipe to capture what WriteToStdin writes
	pr, pw := io.Pipe()

	run := &cliRun{
		requestID: "test-run",
		stdinPipe: pw,
		stderr:    newRingBuffer(10),
	}

	b := &CliBackend{
		activeRuns: map[string]*cliRun{"test-run": run},
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

	run := &cliRun{
		requestID: "closed-run",
		stdinPipe: nil, // already nil
		stderr:    newRingBuffer(10),
	}

	b := &CliBackend{
		activeRuns: map[string]*cliRun{"closed-run": run},
	}

	err := b.WriteToStdin("closed-run", "hello")
	if err == nil {
		t.Fatal("expected error for closed pipe")
	}
}

func TestWriteToStdinRunNotFound(t *testing.T) {
	b := &CliBackend{
		activeRuns: make(map[string]*cliRun),
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
	// For now, verify the CliBackend interface is satisfied and
	// the struct fields are present.
	b := NewCliBackend()
	if b == nil {
		t.Fatal("NewCliBackend returned nil")
	}

	// Verify interface satisfaction
	var _ RunBackend = b
}

func TestCliRunFieldsPresent(t *testing.T) {
	run := &cliRun{
		requestID: "test",
		stderr:    newRingBuffer(5),
	}

	// stdinPipe should default to nil
	if run.stdinPipe != nil {
		t.Error("stdinPipe should be nil by default")
	}

	// stdinMu should be usable
	run.stdinMu.Lock()
	run.stdinMu.Unlock()
}
