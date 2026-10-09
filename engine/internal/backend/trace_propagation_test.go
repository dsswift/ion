package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	testTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
	testSpan  = "00f067aa0ba902b7"
)

func TestWithTraceparentEnv(t *testing.T) {
	ctx := utils.WithSpanID(utils.WithTraceID(context.Background(), testTrace), testSpan)
	env := withTraceparentEnv([]string{"A=1"}, ctx, "test")
	want := "TRACEPARENT=00-" + testTrace + "-" + testSpan + "-01"
	if len(env) != 2 || env[1] != want {
		t.Fatalf("env = %v, want [A=1 %s]", env, want)
	}
	if env := withTraceparentEnv([]string{"A=1"}, context.Background(), "test"); len(env) != 1 {
		t.Errorf("spawn outside a trace must add nothing, got %v", env)
	}
}

// The provider request made for one llm.call names that span as its parent.
func TestWithLlmCallSpanParentsRequestUnderSpan(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	span := col.StartSpanCtx("llm.call", nil, map[string]any{"trace_id": testTrace, "parent_span_id": testSpan})
	ctx := withLlmCallSpan(utils.WithSpanID(utils.WithTraceID(context.Background(), testTrace), testSpan), span)
	if got := utils.SpanIDFromContext(ctx); got != span.SpanID() {
		t.Errorf("enclosing span = %q, want the llm.call span %q", got, span.SpanID())
	}
	if got := utils.TraceparentFromContext(ctx); got != utils.FormatTraceparent(testTrace, span.SpanID()) {
		t.Errorf("traceparent = %q", got)
	}
	// A nil span (telemetry disabled) leaves the run span in place.
	runCtx := utils.WithSpanID(context.Background(), testSpan)
	if got := utils.SpanIDFromContext(withLlmCallSpan(runCtx, nil)); got != testSpan {
		t.Errorf("nil span changed the enclosing span to %q", got)
	}
}
