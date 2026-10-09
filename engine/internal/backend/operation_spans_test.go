package backend

import (
	"context"
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// The run-loop span helpers record on a real telemetry.Collector here, not
// mockTelemetry, so each test sees the true span_id, duration_ms, trace, and
// parent the collector writes.

const (
	spanTestTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	spanTestRunSpan = "00f067aa0ba902b7"
)

// collectorTelemetry adapts a telemetry.Collector to TelemetryCollector.
type collectorTelemetry struct{ c *telemetry.Collector }

func (a collectorTelemetry) Event(name string, payload, ctx map[string]interface{}) {
	a.c.Event(name, payload, ctx)
}
func (a collectorTelemetry) StartSpan(name string, attrs map[string]interface{}) Span {
	return a.c.StartSpan(name, attrs)
}
func (a collectorTelemetry) StartSpanCtx(name string, attrs, ctx map[string]interface{}) Span {
	return a.c.StartSpanCtx(name, attrs, ctx)
}
func (a collectorTelemetry) PrivacyLevel() string { return a.c.PrivacyLevel() }

// newSpanTestRun returns a run whose context carries the run's trace and its
// run.execute span, recording on a fresh collector.
func newSpanTestRun(t *testing.T, conversationID string) (*activeRun, *telemetry.Collector) {
	t.Helper()
	c := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	parent := utils.WithSpanID(utils.WithTraceID(context.Background(), spanTestTraceID), spanTestRunSpan)
	run := &activeRun{
		requestID: "req-span",
		conv:      conversation.CreateConversation(conversationID, "", "test-model"),
		cfg:       &RunConfig{Telemetry: collectorTelemetry{c}},
		opts:      &types.RunOptions{ConversationID: conversationID, ParentCtx: parent},
	}
	return run, c
}

// onlySpan returns the single event named name, failing unless it is a span
// (a valid span_id and a numeric duration_ms) under the wanted trace and
// parent.
func onlySpan(t *testing.T, c *telemetry.Collector, name, wantParent string) telemetry.Event {
	t.Helper()
	var found []telemetry.Event
	for _, e := range c.BufferedEvents() {
		if e.Name == name {
			found = append(found, e)
		}
	}
	if len(found) != 1 {
		t.Fatalf("%s events = %d, want 1", name, len(found))
	}
	e := found[0]
	if id, _ := e.Payload["span_id"].(string); !utils.IsValidSpanID(id) { //nolint:errcheck // a missing id fails below
		t.Fatalf("%s span_id = %v, want a valid span id", name, e.Payload["span_id"])
	}
	if d, ok := e.Payload["duration_ms"].(float64); !ok || d < 0 {
		t.Fatalf("%s duration_ms = %v, want a non-negative float", name, e.Payload["duration_ms"])
	}
	if e.TraceID != spanTestTraceID {
		t.Fatalf("%s trace_id = %q, want %q", name, e.TraceID, spanTestTraceID)
	}
	if e.ParentSpanID != wantParent {
		t.Fatalf("%s parent_span_id = %q, want %q", name, e.ParentSpanID, wantParent)
	}
	return e
}

func TestConversationPersistSpan(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	run, c := newSpanTestRun(t, "conv-persist-span")
	run.conv.Messages = append(run.conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	if err := persistConversation(run, run.conv); err != nil {
		t.Fatalf("persist: %v", err)
	}
	e := onlySpan(t, c, telemetry.ConversationPersist, spanTestRunSpan)
	if e.Payload["messages"] != 1 {
		t.Fatalf("messages = %v, want 1", e.Payload["messages"])
	}
	if _, has := e.Payload["error"]; has {
		t.Fatalf("a successful save carried an error: %v", e.Payload["error"])
	}
}

func TestConversationLoadSpanCreatesWithoutError(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	run, c := newSpanTestRun(t, "conv-load-span")
	conv, err := loadOrCreateConversationSpan(run, *run.opts, "test-model")
	if err != nil || conv == nil {
		t.Fatalf("load: conv=%v err=%v", conv, err)
	}
	e := onlySpan(t, c, telemetry.ConversationLoad, spanTestRunSpan)
	if e.Payload["source"] != "run" || e.Payload["created"] != true {
		t.Fatalf("payload = %v, want source=run created=true", e.Payload)
	}
	if _, has := e.Payload["error"]; has {
		t.Fatalf("a not-found load is not a span error: %v", e.Payload["error"])
	}
}

func TestContextAssembleSpan(t *testing.T) {
	run, c := newSpanTestRun(t, "conv-ctx-span")
	span := startContextAssembleSpan(run, 3)
	endContextAssembleSpan(span, &types.LlmStreamOptions{
		Model: "m", System: "sys", Messages: []types.LlmMessage{{Role: "user", Content: "a"}, {Role: "user", Content: "b"}},
	}, 1)
	e := onlySpan(t, c, telemetry.ContextAssemble, spanTestRunSpan)
	if e.Payload["turn"] != 3 || e.Payload["messages"] != 2 || e.Payload["initial_messages"] != 1 || e.Payload["has_system"] != true {
		t.Fatalf("payload = %v", e.Payload)
	}
}

func TestPermissionDecideSpan(t *testing.T) {
	run, c := newSpanTestRun(t, "conv-perm-span")
	span := startPermissionDecideSpan(runTelemetry(run), run, "Bash")
	endPermissionDecideSpan(span, &permissions.CheckResult{Decision: "deny", Layer: "dangerous_pattern"}, "high")
	e := onlySpan(t, c, telemetry.PermissionDecide, spanTestRunSpan)
	if e.Payload["tool"] != "Bash" || e.Payload["decision"] != "deny" || e.Payload["deciding_layer"] != "dangerous_pattern" {
		t.Fatalf("payload = %v", e.Payload)
	}
}

// llm.attempt is the child of the llm.call in flight, not of run.execute,
// and carries the attempt's ttft_ms and outcome.
func TestLlmAttemptSpanParentsUnderLlmCall(t *testing.T) {
	run, c := newSpanTestRun(t, "conv-attempt-span")
	const llmCall = "1111222233334444"
	run.setLlmCallSpan(llmCall)
	start := attemptSpanStarter(runTelemetry(run), run, 2)
	end := start(1, "m", "anthropic")
	end("retry", 0, errors.New("overloaded"))
	end2 := start(2, "m", "anthropic")
	end2("ok", 412.5, nil)

	var attempts []telemetry.Event
	for _, e := range c.BufferedEvents() {
		if e.Name == telemetry.LlmAttempt {
			attempts = append(attempts, e)
		}
	}
	if len(attempts) != 2 {
		t.Fatalf("llm.attempt events = %d, want one per attempt", len(attempts))
	}
	for _, e := range attempts {
		if e.ParentSpanID != llmCall || e.TraceID != spanTestTraceID {
			t.Fatalf("attempt parent/trace = %s/%s, want %s/%s", e.ParentSpanID, e.TraceID, llmCall, spanTestTraceID)
		}
		if _, ok := e.Payload["duration_ms"].(float64); !ok {
			t.Fatalf("attempt duration_ms = %v", e.Payload["duration_ms"])
		}
	}
	if attempts[0].Payload["error"] != "overloaded" || attempts[0].Payload["outcome"] != "retry" {
		t.Fatalf("first attempt = %v", attempts[0].Payload)
	}
	if attempts[1].Payload["ttft_ms"] != 412.5 || attempts[1].Payload["attempt"] != 2 {
		t.Fatalf("second attempt = %v", attempts[1].Payload)
	}
	if attemptSpanStarter(nil, run, 1) != nil {
		t.Fatal("a nil collector must observe nothing")
	}
}

// compaction is a span under run.execute, timed from its start to the
// compacted tree's persistence.
func TestCompactionIsASpan(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run, c := newSpanTestRun(t, "conv-compact-span")
	for i := 0; i < 12; i++ {
		run.conv.Messages = append(run.conv.Messages,
			types.LlmMessage{Role: "user", Content: "question here"},
			types.LlmMessage{Role: "assistant", Content: "answer here"})
	}
	u := types.LlmUsage{InputTokens: 180_000}
	run.conv.Messages[len(run.conv.Messages)-1].Usage = &u
	cp := testCompactParams()
	cp.summaryEnabled = false
	b.performCompact(performCompactParams{
		ctx: context.Background(), run: run, conv: run.conv, contextWindow: 200_000, tokenLimit: 100_000, cp: cp, trigger: "auto",
	})
	e := onlySpan(t, c, telemetry.Compaction, spanTestRunSpan)
	if e.Payload["trigger"] != "auto" {
		t.Fatalf("trigger = %v", e.Payload["trigger"])
	}
}
