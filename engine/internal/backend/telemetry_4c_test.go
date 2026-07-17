package backend

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestCompactionTelemetry verifies that performCompact emits a compaction
// telemetry event carrying the before/after token and message counts and the
// reclaimed delta. Goes red if the emission is removed from performCompact.
func TestCompactionTelemetry(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	telem := &mockTelemetry{}
	conv := conversation.CreateConversation("compact-telem", "", "test-model")
	for i := 0; i < 12; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "question here"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "answer here"})
	}
	// Prime Usage on the last assistant message so GetContextUsage reports 180k tokens.
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role == "assistant" {
			u := types.LlmUsage{InputTokens: 180_000}
			conv.Messages[i].Usage = &u
			break
		}
	}

	run := &activeRun{
		requestID: "compact-telem",
		conv:      conv,
		cfg:       &RunConfig{Telemetry: telem},
	}
	cp := testCompactParams()
	cp.summaryEnabled = false // keep hermetic (no live LLM summary)

	b.performCompact(performCompactParams{
		ctx:           context.Background(),
		run:           run,
		conv:          conv,
		hooks:         RunHooks{},
		contextWindow: 200_000,
		tokenLimit:    100_000,
		cp:            cp,
		trigger:       "auto",
	})

	got := telem.eventsByName("compaction")
	if len(got) != 1 {
		t.Fatalf("expected 1 compaction event, got %d", len(got))
	}
	p := got[0].Payload
	if p["trigger"] != "auto" {
		t.Errorf("trigger = %v, want auto", p["trigger"])
	}
	if _, ok := p["tokens_before"].(int); !ok {
		t.Errorf("tokens_before missing/wrong type: %v", p["tokens_before"])
	}
	if _, ok := p["tokens_after"].(int); !ok {
		t.Errorf("tokens_after missing/wrong type: %v", p["tokens_after"])
	}
	if _, ok := p["tokens_reclaimed"].(int); !ok {
		t.Errorf("tokens_reclaimed missing: %v", p["tokens_reclaimed"])
	}
	if p["messages_before"] != len(conv.Messages) && p["messages_before"] == nil {
		t.Errorf("messages_before missing")
	}
}

// TestCompactionReactiveTelemetry verifies compactReactive emits a compaction
// event with trigger "reactive" and micro_only false.
func TestCompactionReactiveTelemetry(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	telem := &mockTelemetry{}
	conv := conversation.CreateConversation("compact-reactive", "", "test-model")
	for i := 0; i < 12; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}
	run := &activeRun{
		requestID: "compact-reactive",
		conv:      conv,
		cfg:       &RunConfig{Telemetry: telem},
	}
	cp := testCompactParams()
	cp.summaryEnabled = false

	b.compactReactive(context.Background(), run, conv, RunHooks{}, 200_000, 1, cp)

	got := telem.eventsByName("compaction")
	if len(got) != 1 {
		t.Fatalf("expected 1 compaction event, got %d", len(got))
	}
	if got[0].Payload["trigger"] != "reactive" {
		t.Errorf("trigger = %v, want reactive", got[0].Payload["trigger"])
	}
	if got[0].Payload["micro_only"] != false {
		t.Errorf("micro_only = %v, want false", got[0].Payload["micro_only"])
	}
}

// TestContextPressureTelemetry verifies that a full run emits a context.pressure
// event per turn. Goes red if the emission is removed from runLoop.
func TestContextPressureTelemetry(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("done", 10, 5),
	})
	b := NewApiBackend()
	telem := &mockTelemetry{}
	c := collectEvents(b, "req-pressure")
	b.StartRunWithConfig("req-pressure", types.RunOptions{
		Prompt:           "context pressure test",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{Telemetry: telem})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	got := telem.eventsByName("context.pressure")
	if len(got) < 1 {
		t.Fatalf("expected at least 1 context.pressure event, got %d", len(got))
	}
	p := got[0].Payload
	if _, ok := p["turn"].(int); !ok {
		t.Errorf("turn missing/wrong type: %v", p["turn"])
	}
	if cw, ok := p["context_window"].(int); !ok || cw <= 0 {
		t.Errorf("context_window = %v, want > 0", p["context_window"])
	}
	if _, ok := p["tokens_used"].(int); !ok {
		t.Errorf("tokens_used missing: %v", p["tokens_used"])
	}
	if _, ok := p["compact_limit"].(int); !ok {
		t.Errorf("compact_limit missing: %v", p["compact_limit"])
	}
}
