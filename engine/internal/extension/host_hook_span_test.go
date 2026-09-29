package extension

import "testing"

// Inside a run, a hook call is recorded as a span under the run's span.
func TestCallHook_RecordsSpanUnderRun(t *testing.T) {
	h := loadHookLatencyExt(t, "my-ext", "")
	var got []capturedTelem
	h.SetTelemetrySink(func(event string, payload, ctx map[string]any) {
		if event == "extension.hook_latency" {
			got = append(got, capturedTelem{event, payload, ctx})
		}
	})

	ctx := &Context{Cwd: "/tmp", TraceID: "4bf92f3577b34da6a3ce929d0e0e4736", RunSpanID: "00f067aa0ba902b7"}
	if _, err := h.callHook("hook/tool_call", ctx, nil); err != nil {
		t.Fatalf("callHook: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("events = %d", len(got))
	}
	e := got[0]
	if e.ctx["trace_id"] != ctx.TraceID || e.ctx["parent_span_id"] != ctx.RunSpanID {
		t.Errorf("ctx = %v", e.ctx)
	}
	if id, _ := e.payload["span_id"].(string); len(id) != 16 { //nolint:errcheck // asserted below
		t.Errorf("span_id = %v", e.payload["span_id"])
	}
	if e.payload["duration_ms"] != e.payload["latency_ms"] {
		t.Errorf("duration_ms = %v, latency_ms = %v", e.payload["duration_ms"], e.payload["latency_ms"])
	}
}

// Outside a run there is no span to parent to, so the event stays a point.
func TestCallHook_NoSpanOutsideRun(t *testing.T) {
	h := loadHookLatencyExt(t, "my-ext", "")
	var got []capturedTelem
	h.SetTelemetrySink(func(event string, payload, ctx map[string]any) {
		got = append(got, capturedTelem{event, payload, ctx})
	})
	if _, err := h.callHook("hook/session_start", &Context{Cwd: "/tmp"}, nil); err != nil {
		t.Fatalf("callHook: %v", err)
	}
	for _, e := range got {
		if _, ok := e.payload["span_id"]; ok {
			t.Errorf("%s carries span_id outside a run", e.name)
		}
	}
}
