package telemetry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestCollectorFlushesOnInterval is the primary regression test for the
// periodic-flush fix (root cause 1 of the Cost dashboard gap).
//
// Before the fix: Collector.Event() only flushed when batchSize > 0 &&
// len(buffer) >= batchSize. The operator's default config has no batchSize,
// so the batch-flush guard was never entered and events only reached disk at
// session teardown — a session-long blind spot. This test proves the fix by
// asserting that a single event lands on disk within ~1 second WITHOUT an
// explicit Flush() or teardown, using only the periodic ticker.
//
// RED on unfixed code: the file stays empty (the batchSize==0 guard skips the
// flush) and the poll below times out.
// GREEN with the fix: the ticker fires at FlushIntervalMs=50ms and writes the
// event to disk well within the 1 s poll window.
func TestCollectorFlushesOnInterval(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "telemetry.jsonl")

	// Match the operator's real config: no BatchSize, file target. The only
	// difference from production is FlushIntervalMs=50ms so the test is fast.
	c := NewCollector(types.TelemetryConfig{
		Enabled:         true,
		Targets:         []string{"file"},
		FilePath:        fp,
		FlushIntervalMs: 50,
		// BatchSize intentionally zero — this is the real operator config.
	})
	// Do not call Close/Flush — the ticker must do all the work.
	t.Cleanup(func() { c.Close() })

	c.Event(RunComplete, map[string]any{"costUsd": 0.01}, nil)

	// Poll for up to 1 s in 20 ms increments. The 50 ms ticker should fire at
	// most three times within that window, which is plenty.
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(fp)
		if err == nil && len(data) > 0 {
			// File has content — parse and verify it is our event.
			var evt Event
			if jsonErr := json.Unmarshal(data, &evt); jsonErr != nil {
				t.Fatalf("event on disk is not valid JSON: %v\nraw: %s", jsonErr, data)
			}
			if evt.Name != RunComplete {
				t.Errorf("expected event name %q, got %q", RunComplete, evt.Name)
			}
			return // SUCCESS
		}
		time.Sleep(20 * time.Millisecond)
	}

	t.Fatalf("event never reached disk within 1 s without explicit Flush/teardown — periodic flush goroutine not running")
}

// TestCollectorCloseFlushesRemainder verifies that Close() performs a final
// drain flush so events buffered since the last tick are not lost on clean
// engine shutdown. Also verifies Close() is safe to call multiple times.
//
// RED on unfixed code (before Close() existed): the event sits in the buffer
// forever — no Close(), no final flush, no on-disk write.
func TestCollectorCloseFlushesRemainder(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "telemetry.jsonl")

	// Use a very long flush interval so the ticker does NOT fire during the
	// test. Only the Close() final drain should write the event.
	c := NewCollector(types.TelemetryConfig{
		Enabled:         true,
		Targets:         []string{"file"},
		FilePath:        fp,
		FlushIntervalMs: 60_000, // 60 s — ticker will not fire during this test
	})

	c.Event(LlmCall, map[string]any{"model": "claude-test"}, nil)

	// File must be empty before Close() — the ticker hasn't fired.
	data, _ := os.ReadFile(fp)
	if len(data) > 0 {
		t.Fatalf("expected empty file before Close(); got %d bytes — ticker fired too early", len(data))
	}

	// First Close() should flush the event.
	c.Close()

	data, err := os.ReadFile(fp)
	if err != nil {
		t.Fatalf("ReadFile after Close: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("file is empty after Close() — final drain did not flush buffered event")
	}

	var evt Event
	if err := json.Unmarshal(data, &evt); err != nil {
		t.Fatalf("event on disk is not valid JSON after Close: %v\nraw: %s", err, data)
	}
	if evt.Name != LlmCall {
		t.Errorf("expected event name %q, got %q", LlmCall, evt.Name)
	}

	// Second Close() must be a no-op (idempotent), not panic or deadlock.
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.Close()
	}()
	select {
	case <-done:
		// Good — second Close() returned.
	case <-time.After(2 * time.Second):
		t.Fatal("second Close() did not return within 2 s — likely deadlocked")
	}
}
