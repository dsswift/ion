package extcontext

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	parentTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
	parentSpan  = "00f067aa0ba902b7"
)

func findEvent(events []telemetry.Event, name string) *telemetry.Event {
	for i := range events {
		if events[i].Name == name {
			return &events[i]
		}
	}
	return nil
}

// A foreground dispatch under a traced run produces the tree
// run(parent) -> dispatch.agent -> run.execute(child): dispatch.agent carries
// the parent's trace and span, and the child's run.execute is parented to
// the dispatch.agent span in the same trace.
func TestDispatchSpanTreeUnderParentRun(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	acc := &depthTestAccessor{telem: col}
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	runCtx := utils.WithSpanID(utils.WithTraceID(context.Background(), parentTrace), parentSpan)
	_, _ = dispatchFn(extension.DispatchAgentOpts{ //nolint:errcheck // the child fails fast (no provider); the spans are what this test reads
		WaitForCompletion: true, ParentCtx: runCtx,
		Name: "tree-agent", Task: "trace me", Model: "no-such-model-for-trace",
	})

	events := col.BufferedEvents()
	dispatch := findEvent(events, telemetry.DispatchAgent)
	if dispatch == nil {
		t.Fatal("no dispatch.agent span")
	}
	if dispatch.TraceID != parentTrace || dispatch.ParentSpanID != parentSpan {
		t.Errorf("dispatch.agent trace/parent = %q/%q, want %q/%q", dispatch.TraceID, dispatch.ParentSpanID, parentTrace, parentSpan)
	}
	dispatchSpanID, _ := dispatch.Payload["span_id"].(string) //nolint:errcheck // asserted below
	if !utils.IsValidSpanID(dispatchSpanID) {
		t.Fatalf("dispatch.agent span_id = %v", dispatch.Payload["span_id"])
	}

	run := findEvent(events, telemetry.RunExecute)
	if run == nil {
		t.Fatal("no run.execute span for the child run")
	}
	if run.TraceID != parentTrace {
		t.Errorf("child run.execute trace = %q, want %q", run.TraceID, parentTrace)
	}
	if run.ParentSpanID != dispatchSpanID {
		t.Errorf("child run.execute parent = %q, want the dispatch.agent span %q", run.ParentSpanID, dispatchSpanID)
	}
	if run.Payload["span_kind"] != telemetry.SpanKindServer || run.Payload["dispatch_depth"] != 1 {
		t.Errorf("child run.execute payload = %v", run.Payload)
	}
	if _, ok := run.Payload["duration_ms"]; !ok {
		t.Error("child run.execute lacks duration_ms")
	}
	if run.Context["run_id"] == "" || run.Context["run_id"] == nil {
		t.Error("child run.execute lacks run_id")
	}
}

// A dispatch with no trace in flight mints one, so dispatch.agent still
// exports and the child's run hangs beneath it.
func TestDispatchMintsTraceWithoutRun(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	acc := &depthTestAccessor{telem: col}
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	_, _ = dispatchFn(extension.DispatchAgentOpts{ //nolint:errcheck // see TestDispatchSpanTreeUnderParentRun
		WaitForCompletion: true, Name: "minted-agent", Task: "trace me", Model: "no-such-model-for-trace",
	})
	events := col.BufferedEvents()
	dispatch := findEvent(events, telemetry.DispatchAgent)
	if dispatch == nil {
		t.Fatal("no dispatch.agent span")
	}
	if !utils.IsValidTraceID(dispatch.TraceID) {
		t.Errorf("dispatch.agent trace = %q, want a minted trace", dispatch.TraceID)
	}
	if dispatch.ParentSpanID != "" {
		t.Errorf("minted dispatch.agent must be a root, parent = %q", dispatch.ParentSpanID)
	}
	run := findEvent(events, telemetry.RunExecute)
	if run == nil || run.TraceID != dispatch.TraceID || run.ParentSpanID != dispatch.Payload["span_id"] {
		t.Errorf("child run.execute = %+v, want trace %q under the dispatch span", run, dispatch.TraceID)
	}
}

// Child run options carry the child's run span, not the parent's, so the
// child's llm.call and tool.execute spans nest under the child run.
func TestChildRunTraceContextStampsChildRunSpan(t *testing.T) {
	tr := dispatchTrace{traceID: parentTrace, parentSpanID: parentSpan}
	child := tr.child(nil)
	ctx := child.context(context.Background())
	if utils.TraceIDFromContext(ctx) != parentTrace {
		t.Errorf("trace = %q", utils.TraceIDFromContext(ctx))
	}
	if got := utils.SpanIDFromContext(ctx); got != child.runSpanID || got == parentSpan {
		t.Errorf("enclosing span = %q, want the child run span %q", got, child.runSpanID)
	}
	if child.runParentSpanID() != parentSpan {
		t.Errorf("without a dispatch span the child run parents to the dispatching run, got %q", child.runParentSpanID())
	}
	ev := child.stamp(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "x"}})
	if ev.TraceID != parentTrace || ev.SpanID != child.runSpanID {
		t.Errorf("stamped event = %q/%q", ev.TraceID, ev.SpanID)
	}
}
