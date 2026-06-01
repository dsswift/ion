package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// captureEvents wires the backend's normalized-event callback into a slice
// so tests can inspect what compactIfNeeded emitted.
func captureEvents(b *ApiBackend, requestID string) *[]types.NormalizedEvent {
	var captured []types.NormalizedEvent
	b.OnNormalized(func(id string, ev types.NormalizedEvent) {
		if id == requestID {
			captured = append(captured, ev)
		}
	})
	return &captured
}

// testCompactParams returns a compactParams with sensible defaults for tests.
func testCompactParams() compactParams {
	return compactParams{
		targetPercent:     conversation.DefaultTargetPercent,
		microKeepTurns:    conversation.DefaultMicroCompactKeep,
		minKeepTurns:      conversation.DefaultMinKeepTurns,
		estimationPadding: conversation.DefaultEstimationPadding,
		summaryEnabled:    true,
	}
}

func TestCompactIfNeeded_CircuitBreaker(t *testing.T) {
	b := NewApiBackend()
	events := captureEvents(b, "circuit-test")

	conv := conversation.CreateConversation("circuit-test", "", "test-model")
	// Provide enough messages for CompactToTokenBudget to drop something but
	// not collapse to empty. The actual content does not matter for this test.
	for i := 0; i < 12; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	run := &activeRun{requestID: "circuit-test", conv: conv}
	ctx := context.Background()
	cp := testCompactParams()

	// Each iteration simulates a runloop pass where the reported token count
	// is stuck above the limit (e.g. the model keeps returning a huge prompt
	// usage figure). Re-priming LastInputTokens between calls mimics what
	// would happen if a successful response set it high and compaction
	// failed to shrink the working set.
	for i := 0; i < maxConsecutiveCompactions; i++ {
		conv.LastInputTokens = 180_000
		conv.LastInputTokensMsgCount = len(conv.Messages)
		b.compactIfNeeded(ctx, run, conv, RunHooks{}, 200_000, 100_000, cp)
	}

	if run.compactionsWithoutProgress != maxConsecutiveCompactions {
		t.Fatalf("compactionsWithoutProgress = %d, want %d",
			run.compactionsWithoutProgress, maxConsecutiveCompactions)
	}

	// Fourth attempt: should hit the circuit breaker and emit
	// compact_loop_aborted instead of running another compaction.
	conv.LastInputTokens = 180_000
	conv.LastInputTokensMsgCount = len(conv.Messages)
	beforeCounter := run.compactionsWithoutProgress
	b.compactIfNeeded(ctx, run, conv, RunHooks{}, 200_000, 100_000, cp)

	if run.compactionsWithoutProgress != beforeCounter {
		t.Errorf("counter advanced past circuit breaker: %d -> %d",
			beforeCounter, run.compactionsWithoutProgress)
	}

	// Confirm a compact_loop_aborted ErrorEvent was emitted.
	var sawAborted bool
	for _, ev := range *events {
		if errEv, ok := ev.Data.(*types.ErrorEvent); ok && errEv.ErrorCode == "compact_loop_aborted" {
			sawAborted = true
			break
		}
	}
	if !sawAborted {
		t.Errorf("expected ErrorEvent with code compact_loop_aborted; saw %d events", len(*events))
	}
}

func TestCompactIfNeeded_BelowLimitIsNoOp(t *testing.T) {
	b := NewApiBackend()
	events := captureEvents(b, "below-limit")

	conv := conversation.CreateConversation("below-limit", "", "test-model")
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	conv.LastInputTokens = 1000
	conv.LastInputTokensMsgCount = 1

	run := &activeRun{requestID: "below-limit", conv: conv}
	ctx := context.Background()
	cp := testCompactParams()

	b.compactIfNeeded(ctx, run, conv, RunHooks{}, 200_000, 100_000, cp)

	if run.compactionsWithoutProgress != 0 {
		t.Errorf("counter advanced on no-op call: %d", run.compactionsWithoutProgress)
	}
	if len(*events) != 0 {
		t.Errorf("expected no events on below-limit call, got %d", len(*events))
	}
}

func TestCompactIfNeeded_DisabledByConfig(t *testing.T) {
	b := NewApiBackend()
	events := captureEvents(b, "disabled-test")

	conv := conversation.CreateConversation("disabled-test", "", "test-model")
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	conv.LastInputTokens = 180_000
	conv.LastInputTokensMsgCount = 1

	disabled := false
	run := &activeRun{
		requestID: "disabled-test",
		conv:      conv,
		opts:      &types.RunOptions{CompactEnabled: &disabled},
	}
	ctx := context.Background()
	cp := testCompactParams()

	b.compactIfNeeded(ctx, run, conv, RunHooks{}, 200_000, 100_000, cp)

	if run.compactionsWithoutProgress != 0 {
		t.Errorf("counter advanced when compact disabled: %d", run.compactionsWithoutProgress)
	}
	if len(*events) != 0 {
		t.Errorf("expected no events when compact disabled, got %d", len(*events))
	}
}

// TestCompactReactive_HookReceivesFacts pins the contract added for issue #129:
// after reactive compaction runs, the OnSessionCompact hook must receive the
// facts the engine extracted from the pre-compaction message set, as a typed
// []compaction.Fact under the "facts" key on the map payload. The session
// bridge in prompt_runconfig.go relies on this exact shape; if the producer
// stops embedding the typed slice (or switches to a stringly-typed shape),
// this test catches it.
func TestCompactReactive_HookReceivesFacts(t *testing.T) {
	b := NewApiBackend()
	_ = captureEvents(b, "reactive-facts")

	conv := conversation.CreateConversation("reactive-facts", "", "test-model")
	// Seed messages with text matching the decision and error fact patterns
	// (see internal/compaction/compaction.go regexes). Reactive compaction
	// does not gate on a token threshold — the runloop calls it whenever the
	// provider returns prompt_too_long — so any non-empty conversation drives
	// the full step-1 + step-2 + step-3 pipeline.
	conv.Messages = append(conv.Messages,
		types.LlmMessage{Role: "user", Content: "We decided to use SQLite for storage."},
		types.LlmMessage{Role: "assistant", Content: "The build failed on darwin due to a linker error."},
	)
	// Pad so CompactToTokenBudget has something to truncate without
	// emptying the conversation.
	for i := 0; i < 20; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "filler q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "filler a"})
	}

	run := &activeRun{requestID: "reactive-facts", conv: conv}
	ctx := context.Background()
	cp := testCompactParams()

	var capturedInfo interface{}
	var hookFired bool
	hooks := RunHooks{
		OnSessionCompact: func(_ string, info interface{}) {
			hookFired = true
			capturedInfo = info
		},
	}

	ok := b.compactReactive(ctx, run, conv, hooks, 200_000, 1, cp)
	if !ok {
		t.Fatalf("compactReactive returned false; expected true")
	}
	if !hookFired {
		t.Fatalf("OnSessionCompact hook did not fire")
	}

	m, ok := capturedInfo.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map payload, got %T", capturedInfo)
	}
	if got := m["strategy"]; got != "reactive" {
		t.Errorf("strategy = %v, want reactive", got)
	}
	rawFacts, ok := m["facts"].([]compaction.Fact)
	if !ok {
		t.Fatalf("expected facts as []compaction.Fact, got %T (value: %v)", m["facts"], m["facts"])
	}

	// At minimum we expect one decision and one error fact from the seeded
	// text. The extractor may emit additional facts (e.g. discoveries) from
	// the filler — we only assert the two we deliberately seeded.
	sawDecision, sawError := false, false
	for _, f := range rawFacts {
		switch f.Type {
		case "decision":
			sawDecision = true
		case "error":
			sawError = true
		}
	}
	if !sawDecision {
		t.Errorf("expected a decision fact in hook payload; got %d facts: %+v", len(rawFacts), rawFacts)
	}
	if !sawError {
		t.Errorf("expected an error fact in hook payload; got %d facts: %+v", len(rawFacts), rawFacts)
	}

	// Verify new CompactionInfo fields are present in the hook payload map.
	if _, ok := m["tokensBefore"]; !ok {
		t.Errorf("expected tokensBefore key in hook payload")
	}
	if _, ok := m["microCompactKeep"]; !ok {
		t.Errorf("expected microCompactKeep key in hook payload")
	}
	if got, ok := m["microCompactKeep"].(int); !ok {
		t.Errorf("microCompactKeep is not int: %T", m["microCompactKeep"])
	} else if got != conversation.DefaultMicroCompactKeep {
		t.Errorf("microCompactKeep = %d, want %d", got, conversation.DefaultMicroCompactKeep)
	}
	if _, ok := m["tokenLimit"]; !ok {
		t.Errorf("expected tokenLimit key in hook payload")
	}
	if _, ok := m["targetTokens"]; !ok {
		t.Errorf("expected targetTokens key in hook payload")
	}
	if _, ok := m["tokensAfter"]; !ok {
		t.Errorf("expected tokensAfter key in hook payload")
	}
	if _, ok := m["sessionMemory"]; !ok {
		t.Errorf("expected sessionMemory key in hook payload")
	}
}

// TestCompactReactive_HookEmptyFactsWhenNoPatterns is the negative half of
// TestCompactReactive_HookReceivesFacts: when the conversation contains no
// text matching any fact-extractor pattern, the hook still fires and the
// "facts" key is present on the map but its value is an empty/nil slice.
// The session bridge treats a missing key and an empty slice identically; a
// panic on the type assertion in the bridge would catch a regression where
// the producer stops setting the key entirely.
func TestCompactReactive_HookEmptyFactsWhenNoPatterns(t *testing.T) {
	b := NewApiBackend()
	_ = captureEvents(b, "reactive-no-facts")

	conv := conversation.CreateConversation("reactive-no-facts", "", "test-model")
	// Plain filler text — no decision, error, preference, or discovery
	// language; no file paths. Padded to give CompactToTokenBudget something
	// to truncate.
	for i := 0; i < 12; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	run := &activeRun{requestID: "reactive-no-facts", conv: conv}
	ctx := context.Background()
	cp := testCompactParams()

	var capturedInfo interface{}
	var hookFired bool
	hooks := RunHooks{
		OnSessionCompact: func(_ string, info interface{}) {
			hookFired = true
			capturedInfo = info
		},
	}

	ok := b.compactReactive(ctx, run, conv, hooks, 200_000, 1, cp)
	if !ok {
		t.Fatalf("compactReactive returned false; expected true")
	}
	if !hookFired {
		t.Fatalf("OnSessionCompact hook did not fire")
	}

	m, ok := capturedInfo.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map payload, got %T", capturedInfo)
	}
	// Type assertion must succeed (the key is always present, even when
	// empty). The slice itself may be nil or zero-length — both acceptable.
	rawFacts, ok := m["facts"].([]compaction.Fact)
	if !ok {
		t.Fatalf("expected facts key to hold []compaction.Fact even when empty; got %T", m["facts"])
	}
	if len(rawFacts) != 0 {
		t.Errorf("expected zero facts on filler conversation; got %d: %+v", len(rawFacts), rawFacts)
	}
}
