package providers

import (
	"context"
	"sync"
	"testing"
	"time"
)

// captureSink is a StreamTelemetrySink that records emitted events for
// assertion. Guarded by a mutex because streamWithIdle emits from its own
// goroutine.
type captureSink struct {
	mu     sync.Mutex
	events []capturedStreamEvent
}

type capturedStreamEvent struct {
	Name    string
	Payload map[string]any
	Ctx     map[string]any
}

func (s *captureSink) Event(name string, payload, ctx map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, capturedStreamEvent{Name: name, Payload: payload, Ctx: ctx})
}

func (s *captureSink) byName(name string) []capturedStreamEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []capturedStreamEvent
	for _, e := range s.events {
		if e.Name == name {
			out = append(out, e)
		}
	}
	return out
}

// restoreStreamTelemetry snapshots and restores the package-global telemetry
// sink so tests don't leak it into one another.
func restoreStreamTelemetry(t *testing.T) {
	t.Helper()
	prev := resolvedStreamTelemetry()
	t.Cleanup(func() { SetStreamTelemetry(prev) })
}

// TestStreamTelemetry_SummaryOnCleanDrain verifies a provider.stream_summary
// event is emitted with the event count and elapsed/max-gap timings when the
// stream drains cleanly. Goes red if the emission is removed.
func TestStreamTelemetry_SummaryOnCleanDrain(t *testing.T) {
	restoreStreamIdle(t)
	restoreStreamTelemetry(t)
	SetStreamIdleTimeout(500 * time.Millisecond)
	sink := &captureSink{}
	SetStreamTelemetry(sink)

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }
	out, errFn := streamWithIdle(src, srcErr, "test", "model-sum", "req-sum", nil, nil)

	go func() {
		for i := 0; i < 3; i++ {
			src <- SSEEvent{Event: "delta", Data: "{}"}
			time.Sleep(10 * time.Millisecond)
		}
		close(src)
	}()

	for range out {
	}
	if err := errFn(); err != nil {
		t.Fatalf("expected nil error on clean EOF, got %v", err)
	}

	got := sink.byName("provider.stream_summary")
	if len(got) != 1 {
		t.Fatalf("expected 1 provider.stream_summary event, got %d", len(got))
	}
	p := got[0].Payload
	if p["model"] != "model-sum" {
		t.Errorf("model = %v, want model-sum", p["model"])
	}
	if ec, ok := p["event_count"].(int); !ok || ec != 3 {
		t.Errorf("event_count = %v, want 3", p["event_count"])
	}
	if _, ok := p["duration_ms"].(int64); !ok {
		t.Errorf("duration_ms missing/wrong type: %v", p["duration_ms"])
	}
	if _, ok := p["max_gap_ms"].(int64); !ok {
		t.Errorf("max_gap_ms missing/wrong type: %v", p["max_gap_ms"])
	}
}

// TestStreamTelemetry_StallOnSilence verifies a provider.stall event is emitted
// when the stream goes silent past the idle deadline. Goes red if the emission
// is removed.
func TestStreamTelemetry_StallOnSilence(t *testing.T) {
	restoreStreamIdle(t)
	restoreStreamTelemetry(t)
	SetStreamIdleTimeout(50 * time.Millisecond)
	sink := &captureSink{}
	SetStreamTelemetry(sink)

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }
	out, errFn := streamWithIdle(src, srcErr, "test", "model-stall", "req-stall", nil, nil)

	go func() {
		src <- SSEEvent{Event: "message_start", Data: "{}"}
		// then go silent forever
	}()

	// drain until close
	for range out {
	}
	_ = errFn()

	got := sink.byName("provider.stall")
	if len(got) != 1 {
		t.Fatalf("expected 1 provider.stall event, got %d", len(got))
	}
	p := got[0].Payload
	if p["model"] != "model-stall" {
		t.Errorf("model = %v, want model-stall", p["model"])
	}
	if _, ok := p["gap_ms"].(int64); !ok {
		t.Errorf("gap_ms missing/wrong type: %v", p["gap_ms"])
	}
	if _, ok := p["idle_deadline_ms"].(int64); !ok {
		t.Errorf("idle_deadline_ms missing/wrong type: %v", p["idle_deadline_ms"])
	}
	if ec, ok := p["event_count"].(int); !ok || ec != 1 {
		t.Errorf("event_count = %v, want 1", p["event_count"])
	}
}

// TestStreamTelemetry_NilSinkNoop verifies streamWithIdle does not panic when
// no telemetry sink is installed.
func TestStreamTelemetry_NilSinkNoop(t *testing.T) {
	restoreStreamIdle(t)
	restoreStreamTelemetry(t)
	SetStreamIdleTimeout(500 * time.Millisecond)
	SetStreamTelemetry(nil)

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }
	out, errFn := streamWithIdle(src, srcErr, "test", "m", "r", nil, nil)
	go func() {
		src <- SSEEvent{Event: "delta", Data: "{}"}
		close(src)
	}()
	for range out {
	}
	_ = errFn()
}

// TestStreamTelemetry_StallCarriesConversationID verifies that a provider.stall
// event carries the conversation_id from the correlation context plumbed
// through streamWithIdle. Before the fix the stall event emitted with a nil
// ctx, so forensics could not attribute a "provider trouble" signal to the
// conversation. This test fails on the pre-fix code (nil ctx → no
// conversation_id) and passes once the correlation block is threaded.
func TestStreamTelemetry_StallCarriesConversationID(t *testing.T) {
	restoreStreamIdle(t)
	restoreStreamTelemetry(t)
	SetStreamIdleTimeout(50 * time.Millisecond)
	sink := &captureSink{}
	SetStreamTelemetry(sink)

	const convID = "conv-stall-forensics"
	correlation := map[string]any{
		"session_id":      "sess-x",
		"conversation_id": convID,
		"run_id":          "run-x",
	}

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }
	out, errFn := streamWithIdle(src, srcErr, "test", "model-stall", "req-stall", nil, correlation)

	go func() {
		src <- SSEEvent{Event: "message_start", Data: "{}"}
		// then go silent forever
	}()

	for range out {
	}
	_ = errFn()

	got := sink.byName("provider.stall")
	if len(got) != 1 {
		t.Fatalf("expected 1 provider.stall event, got %d", len(got))
	}
	if got[0].Ctx == nil {
		t.Fatal("provider.stall emitted with nil ctx; want correlation block")
	}
	if got[0].Ctx["conversation_id"] != convID {
		t.Errorf("ctx conversation_id = %v, want %q", got[0].Ctx["conversation_id"], convID)
	}
}

// TestStreamTelemetry_SummaryCarriesConversationID verifies the clean-drain
// provider.stream_summary event likewise carries the correlation
// conversation_id. Fails pre-fix (nil ctx), passes with the plumbed block.
func TestStreamTelemetry_SummaryCarriesConversationID(t *testing.T) {
	restoreStreamIdle(t)
	restoreStreamTelemetry(t)
	SetStreamIdleTimeout(500 * time.Millisecond)
	sink := &captureSink{}
	SetStreamTelemetry(sink)

	const convID = "conv-summary-forensics"
	correlation := map[string]any{"conversation_id": convID}

	src := make(chan SSEEvent)
	srcErr := func() error { return nil }
	out, errFn := streamWithIdle(src, srcErr, "test", "model-sum", "req-sum", nil, correlation)

	go func() {
		src <- SSEEvent{Event: "delta", Data: "{}"}
		close(src)
	}()

	for range out {
	}
	if err := errFn(); err != nil {
		t.Fatalf("expected nil error on clean EOF, got %v", err)
	}

	got := sink.byName("provider.stream_summary")
	if len(got) != 1 {
		t.Fatalf("expected 1 provider.stream_summary event, got %d", len(got))
	}
	if got[0].Ctx == nil || got[0].Ctx["conversation_id"] != convID {
		t.Errorf("stream_summary ctx conversation_id = %v, want %q", ctxConvID(got[0].Ctx), convID)
	}
}

// ctxConvID safely extracts conversation_id for the error message above.
func ctxConvID(ctx map[string]any) any {
	if ctx == nil {
		return nil
	}
	return ctx["conversation_id"]
}

// TestWithTelemetryCorrelation_RoundTrip verifies the context carrier stores
// and retrieves the correlation block, and that nil inputs are no-ops.
func TestWithTelemetryCorrelation_RoundTrip(t *testing.T) {
	base := context.Background()

	// nil correlation is a no-op: the base ctx is returned and lookup is nil.
	if got := WithTelemetryCorrelation(base, nil); got != base {
		t.Error("WithTelemetryCorrelation(ctx, nil) should return ctx unchanged")
	}
	if got := telemetryCorrelationFromContext(base); got != nil {
		t.Errorf("telemetryCorrelationFromContext(base) = %v, want nil", got)
	}

	correlation := map[string]any{"conversation_id": "c1"}
	ctx := WithTelemetryCorrelation(base, correlation)
	got := telemetryCorrelationFromContext(ctx)
	if got == nil || got["conversation_id"] != "c1" {
		t.Errorf("round-trip = %v, want conversation_id=c1", got)
	}
}
