package backend

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestSpanCtxCorrelationLlmCall verifies that an llm.call span End emits an
// event whose Context carries session_id and conversation_id. This is the
// regression test for the bug where SpanHandle.End passed nil context,
// stripping correlation from every span-based telemetry event.
//
// Revert check: if SpanHandle.End passes nil instead of s.ctx to
// Collector.Event (the pre-fix behaviour), event.Ctx will be nil and the
// assertions on session_id / conversation_id will fail.
func TestSpanCtxCorrelationLlmCall(t *testing.T) {
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "req-span-llm",
		conv:      &conversation.Conversation{ID: "conv-span-llm"},
		opts:      &types.RunOptions{SessionKey: "sess-span-llm"},
		cfg:       &RunConfig{Telemetry: telem},
	}

	ctx := buildTelemCtx(run)
	span := telem.StartSpanCtx("llm.call", map[string]interface{}{
		"model": "claude-opus-4-5",
		"turn":  1,
	}, ctx)
	span.End(nil)

	events := telem.eventsByName("llm.call")
	if len(events) == 0 {
		t.Fatal("expected at least one llm.call event after span End; got none")
	}
	e := events[0]

	// Context must be non-nil and carry the correlation keys.
	if e.Ctx == nil {
		t.Fatal("llm.call event context is nil; expected session_id and conversation_id")
	}
	if got, ok := e.Ctx["session_id"]; !ok || got != "sess-span-llm" {
		t.Errorf("context session_id = %v, want %q", got, "sess-span-llm")
	}
	if got, ok := e.Ctx["conversation_id"]; !ok || got != "conv-span-llm" {
		t.Errorf("context conversation_id = %v, want %q", got, "conv-span-llm")
	}
	if got, ok := e.Ctx["run_id"]; !ok || got != "req-span-llm" {
		t.Errorf("context run_id = %v, want %q", got, "req-span-llm")
	}

	// Wire shape: the event must serialize context.session_id as
	// "context":{"session_id":"..."} — the field Loki reads as
	// context_session_id via the json parser.
	raw, err := json.Marshal(map[string]interface{}{
		"name":    e.Name,
		"payload": e.Payload,
		"context": e.Ctx,
	})
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var wire struct {
		Context map[string]interface{} `json:"context"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if wire.Context["session_id"] != "sess-span-llm" {
		t.Errorf("serialized context.session_id = %v, want %q", wire.Context["session_id"], "sess-span-llm")
	}
}

// TestSpanCtxCorrelationToolExecute verifies that a tool.execute span End
// emits an event whose Context carries session_id and conversation_id.
//
// Revert check: same as TestSpanCtxCorrelationLlmCall — nil ctx in End
// produces nil e.Ctx, failing the assertion.
func TestSpanCtxCorrelationToolExecute(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "req-span-tool",
		conv:      &conversation.Conversation{ID: "conv-span-tool"},
		opts:      &types.RunOptions{SessionKey: "sess-span-tool"},
		cfg:       &RunConfig{Telemetry: telem},
	}

	// Invoke executeTools with an unknown tool name so it short-circuits after
	// opening (and closing) the tool.execute span without requiring a real tool
	// registry or provider.
	blocks := []types.LlmContentBlock{{
		Name:  "NoSuchToolSpanTest",
		ID:    "tc-span-tool",
		Input: map[string]interface{}{},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}

	events := telem.eventsByName("tool.execute")
	if len(events) == 0 {
		t.Fatal("expected at least one tool.execute event after span End; got none")
	}
	e := events[0]

	if e.Ctx == nil {
		t.Fatal("tool.execute event context is nil; expected session_id and conversation_id")
	}
	if got := e.Ctx["session_id"]; got != "sess-span-tool" {
		t.Errorf("context session_id = %v, want %q", got, "sess-span-tool")
	}
	if got := e.Ctx["conversation_id"]; got != "conv-span-tool" {
		t.Errorf("context conversation_id = %v, want %q", got, "conv-span-tool")
	}
}
