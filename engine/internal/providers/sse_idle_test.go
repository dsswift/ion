package providers

import (
	"sync"
	"testing"
	"time"
)

// sse_idle_test.go — tests for the provider stream-idle deadline + heartbeat
// (sse_idle.go). These pin the originating-stall fix from the
// 1782088921498-960b064fe896 incident: a stream that returns headers then goes
// silent must be converted into a fast, retryable error instead of blocking
// the read loop indefinitely.

// restoreStreamIdle snapshots and restores the package-global idle setting so
// tests don't leak configuration into one another.
func restoreStreamIdle(t *testing.T) {
	t.Helper()
	prev := streamIdleNanos.Load()
	t.Cleanup(func() { streamIdleNanos.Store(prev) })
}

// TestStreamWithIdle_FiresOnSilence is the Layer-A regression test: when the
// source emits one event then goes silent past the idle deadline, errFn must
// report a RETRYABLE stream_truncated error tagged stream_idle — fast (within
// a small multiple of the deadline), not after minutes.
//
// Revert the idle wrapper (route providers straight through ParseSSEStream)
// and the equivalent real-world path hangs forever; here, without the idle
// arm, errFn would block on srcErr() until the source closes (which it never
// does), so the test would time out → red.
func TestStreamWithIdle_FiresOnSilence(t *testing.T) {
	restoreStreamIdle(t)
	SetStreamIdleTimeout(60 * time.Millisecond)

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }

	out, errFn := streamWithIdle(src, srcErr, "test", "model-x", "req-1", nil, nil)

	// Emit one event, then go silent forever.
	go func() {
		src <- SSEEvent{Event: "message_start", Data: "{}"}
		// never close src, never send again → simulate a wedged upstream
	}()

	// Drain the one forwarded event.
	got, ok := <-out
	if !ok || got.Event != "message_start" {
		t.Fatalf("expected first event forwarded, got %+v ok=%v", got, ok)
	}

	// The idle deadline must fire and close out promptly.
	select {
	case _, ok := <-out:
		if ok {
			t.Fatal("expected out to close after idle deadline, got another event")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("out did not close within 2s — idle deadline never fired (stream would hang forever)")
	}

	err := errFn()
	if err == nil {
		t.Fatal("expected a stream_idle error from errFn, got nil")
	}
	pe, ok := err.(*ProviderError)
	if !ok {
		t.Fatalf("expected *ProviderError, got %T: %v", err, err)
	}
	if pe.Code != ErrStreamTruncated {
		t.Errorf("idle error code = %q, want %q", pe.Code, ErrStreamTruncated)
	}
	if !pe.Retryable {
		t.Error("idle error must be Retryable so WithRetry re-streams")
	}
}

// TestStreamWithIdle_ResetsOnEvent asserts the idle timer resets on every
// event: a stream that keeps emitting just inside the deadline never trips it,
// then completes cleanly on EOF.
func TestStreamWithIdle_ResetsOnEvent(t *testing.T) {
	restoreStreamIdle(t)
	SetStreamIdleTimeout(80 * time.Millisecond)

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }

	out, errFn := streamWithIdle(src, srcErr, "test", "model-x", "req-2", nil, nil)

	go func() {
		// 5 events, 30ms apart — each well inside the 80ms deadline.
		for i := 0; i < 5; i++ {
			src <- SSEEvent{Event: "delta", Data: "{}"}
			time.Sleep(30 * time.Millisecond)
		}
		close(src) // clean EOF
	}()

	count := 0
	for range out {
		count++
	}
	if count != 5 {
		t.Fatalf("expected 5 events forwarded, got %d", count)
	}
	if err := errFn(); err != nil {
		t.Fatalf("expected nil error on clean EOF, got %v", err)
	}
}

// TestStreamWithIdle_Disabled asserts a negative configuration disables the
// deadline entirely: a silent stream does NOT produce an idle error (the
// caller relies on transport + run-progress watchdog instead).
func TestStreamWithIdle_Disabled(t *testing.T) {
	restoreStreamIdle(t)
	SetStreamIdleTimeout(-1) // disabled

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }
	out, errFn := streamWithIdle(src, srcErr, "test", "model-x", "req-3", nil, nil)

	go func() {
		src <- SSEEvent{Event: "only", Data: "{}"}
		time.Sleep(150 * time.Millisecond)
		close(src)
	}()

	count := 0
	for range out {
		count++
	}
	if count != 1 {
		t.Fatalf("expected 1 event, got %d", count)
	}
	if err := errFn(); err != nil {
		t.Fatalf("disabled idle deadline must not produce an error, got %v", err)
	}
}

// TestStreamWithIdle_ProgressCallback is the Layer-B regression test: the
// onProgress callback fires on every received event (so the run loop can keep
// its progress clock fresh while a slow-but-alive stream is in flight, and the
// run-progress watchdog does not mistake a streaming run for a stalled one).
func TestStreamWithIdle_ProgressCallback(t *testing.T) {
	restoreStreamIdle(t)
	SetStreamIdleTimeout(200 * time.Millisecond)

	var mu sync.Mutex
	progress := 0
	onProgress := func() {
		mu.Lock()
		progress++
		mu.Unlock()
	}

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }
	out, errFn := streamWithIdle(src, srcErr, "test", "model-x", "req-4", onProgress, nil)

	go func() {
		for i := 0; i < 3; i++ {
			src <- SSEEvent{Event: "delta", Data: "{}"}
		}
		close(src)
	}()

	for range out {
	}
	if err := errFn(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mu.Lock()
	got := progress
	mu.Unlock()
	if got < 3 {
		t.Errorf("expected onProgress called at least once per event (>=3), got %d", got)
	}
}

// TestStreamIdleAccessor_Defaults pins the TimeoutsConfig.StreamIdle accessor
// semantics the wrapper depends on: unset → 90s enabled; positive → that value
// enabled; negative → disabled.
func TestStreamIdleAccessor_Defaults(t *testing.T) {
	restoreStreamIdle(t)

	// resolvedStreamIdle reads the package global; verify its default path.
	SetStreamIdleTimeout(0)
	d, enabled := resolvedStreamIdle()
	if !enabled || d != defaultStreamIdle {
		t.Errorf("default: got (%s, %v), want (%s, true)", d, enabled, defaultStreamIdle)
	}

	SetStreamIdleTimeout(5 * time.Second)
	d, enabled = resolvedStreamIdle()
	if !enabled || d != 5*time.Second {
		t.Errorf("positive: got (%s, %v), want (5s, true)", d, enabled)
	}

	SetStreamIdleTimeout(-1)
	_, enabled = resolvedStreamIdle()
	if enabled {
		t.Error("negative: expected disabled")
	}
}
