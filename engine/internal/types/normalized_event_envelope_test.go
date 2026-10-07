package types

import (
	"encoding/json"
	"testing"
)

// A run-emitted event round-trips its trace position through JSON, and an
// event outside a run writes no trace keys at all.
func TestNormalizedEventTraceEnvelopeRoundTrip(t *testing.T) {
	const trace = "4bf92f3577b34da6a3ce929d0e0e4736"
	const span = "00f067aa0ba902b7"
	in := NormalizedEvent{Data: &TextChunkEvent{Text: "hi"}, TraceID: trace, SpanID: span}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var flat map[string]any
	if err := json.Unmarshal(raw, &flat); err != nil {
		t.Fatalf("unmarshal flat: %v", err)
	}
	if flat["type"] != EventTextChunk || flat["trace_id"] != trace || flat["span_id"] != span || flat["text"] != "hi" {
		t.Fatalf("flat JSON = %s", raw)
	}
	var out NormalizedEvent
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal event: %v", err)
	}
	if out.TraceID != trace || out.SpanID != span {
		t.Errorf("trace/span = %q/%q, want %q/%q", out.TraceID, out.SpanID, trace, span)
	}
	if tc, ok := out.Data.(*TextChunkEvent); !ok || tc.Text != "hi" {
		t.Errorf("data = %#v, want the text chunk", out.Data)
	}

	raw, err = json.Marshal(NormalizedEvent{Data: &TextChunkEvent{Text: "idle"}})
	if err != nil {
		t.Fatalf("marshal idle: %v", err)
	}
	flat = nil
	if err := json.Unmarshal(raw, &flat); err != nil {
		t.Fatalf("unmarshal idle: %v", err)
	}
	for _, key := range []string{"trace_id", "span_id"} {
		if _, present := flat[key]; present {
			t.Errorf("event outside a run must omit %s: %s", key, raw)
		}
	}
}

// WithTrace fills only what the event does not already carry.
func TestNormalizedEventWithTraceKeepsCloserStamp(t *testing.T) {
	ev := NormalizedEvent{Data: &TextChunkEvent{}, TraceID: "t1", SpanID: "s1"}.WithTrace("t2", "s2")
	if ev.TraceID != "t1" || ev.SpanID != "s1" {
		t.Errorf("stamped event overwritten: %q/%q", ev.TraceID, ev.SpanID)
	}
	ev = NormalizedEvent{Data: &TextChunkEvent{}}.WithTrace("t2", "s2")
	if ev.TraceID != "t2" || ev.SpanID != "s2" {
		t.Errorf("unstamped event not filled: %q/%q", ev.TraceID, ev.SpanID)
	}
}

// EngineEvent serializes the trace position under the same keys and omits
// them when empty.
func TestEngineEventTraceKeys(t *testing.T) {
	raw, err := json.Marshal(EngineEvent{Type: "engine_text_delta", TraceID: "t", SpanID: "s"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var flat map[string]any
	if err := json.Unmarshal(raw, &flat); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if flat["trace_id"] != "t" || flat["span_id"] != "s" {
		t.Fatalf("engine event JSON = %s", raw)
	}
	raw, err = json.Marshal(EngineEvent{Type: "engine_text_delta"})
	if err != nil {
		t.Fatalf("marshal idle: %v", err)
	}
	flat = nil
	if err := json.Unmarshal(raw, &flat); err != nil {
		t.Fatalf("unmarshal idle: %v", err)
	}
	if _, present := flat["trace_id"]; present {
		t.Errorf("idle engine event must omit trace_id: %s", raw)
	}
}
