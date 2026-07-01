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
	// Skip the LLM-summary tier: this test asserts only the circuit-breaker
	// control flow (compactionsWithoutProgress + compact_loop_aborted), not
	// summarization. Leaving it enabled makes compaction fall through to a
	// live provider.Stream against the default unconfigured Anthropic
	// provider (https://api.anthropic.com, empty key → 401) on every loop
	// iteration, which is non-hermetic, slow, and pollutes engine.log with
	// spurious auth-failure lines. The regex/truncation tail still shrinks
	// the working set, so the circuit-breaker behavior under test is
	// unchanged. (Same skip pattern as runloop_compact_boundary_test.go.)
	cp.summaryEnabled = false

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

// lastCompactingDone returns the final CompactingEvent with Active==false from
// a captured event slice, or nil if none was emitted.
func lastCompactingDone(events []types.NormalizedEvent) *types.CompactingEvent {
	var found *types.CompactingEvent
	for i := range events {
		if ce, ok := events[i].Data.(*types.CompactingEvent); ok && !ce.Active {
			found = ce
		}
	}
	return found
}

// TestPerformCompact_MicroOnlySignal verifies the MicroOnly flag on the
// completion event. When step 1 (micro-compact) brings usage below the limit,
// step 2 (hard truncate) is skipped: no messages are dropped and MicroOnly is
// true. This is the explicit signal clients use to avoid rendering a
// misleading "N → N messages" marker. Reverting the `MicroOnly: !shouldHardTruncate`
// set in performCompact makes this test fail.
func TestPerformCompact_MicroOnlySignal(t *testing.T) {
	b := NewApiBackend()
	events := captureEvents(b, "micro-only")

	conv := conversation.CreateConversation("micro-only", "", "test-model")
	// Recent turns carry large tool_result blocks that micro-compact clears.
	// After clearing, the estimated token count drops far below the limit, so
	// the hard-truncate step is skipped and the pass is micro-only.
	big := make([]byte, 400)
	for i := range big {
		big[i] = 'x'
	}
	for i := 0; i < 6; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: []types.LlmContentBlock{
				{Type: "tool_result", Content: string(big)},
			}},
			types.LlmMessage{Role: "assistant", Content: []types.LlmContentBlock{
				{Type: "text", Text: "ok"},
			}},
		)
	}

	run := &activeRun{requestID: "micro-only", conv: conv}
	cp := testCompactParams()
	cp.summaryEnabled = false // hermetic: no live provider call

	// A high tokenLimit relative to post-micro usage guarantees step 2 is
	// skipped. contextWindow is large; the trigger check is the caller's
	// responsibility (performCompact always compacts), so we invoke it directly.
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

	done := lastCompactingDone(*events)
	if done == nil {
		t.Fatal("expected a CompactingEvent with Active=false")
	}
	if !done.MicroOnly {
		t.Errorf("expected MicroOnly=true on a micro-only pass, got false (msgsBefore=%d msgsAfter=%d)",
			done.MessagesBefore, done.MessagesAfter)
	}
	if done.MessagesBefore != done.MessagesAfter {
		t.Errorf("micro-only pass must not drop messages: before=%d after=%d",
			done.MessagesBefore, done.MessagesAfter)
	}
}

// TestPerformCompact_HardTruncateNotMicroOnly verifies the inverse: when the
// hard-truncate step runs and drops messages, MicroOnly is false.
func TestPerformCompact_HardTruncateNotMicroOnly(t *testing.T) {
	b := NewApiBackend()
	events := captureEvents(b, "hard-trunc")

	conv := conversation.CreateConversation("hard-trunc", "", "test-model")
	// Many short turns with no clearable tool_result blocks: micro-compact
	// clears nothing, usage stays above the (low) limit, step 2 truncates.
	for i := 0; i < 30; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "question here"}}},
			types.LlmMessage{Role: "assistant", Content: []types.LlmContentBlock{{Type: "text", Text: "answer here"}}},
		)
	}
	// Force the post-micro usage above the limit so step 2 runs.
	conv.LastInputTokens = 180_000
	conv.LastInputTokensMsgCount = len(conv.Messages)

	run := &activeRun{requestID: "hard-trunc", conv: conv}
	cp := testCompactParams()
	cp.summaryEnabled = false

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

	done := lastCompactingDone(*events)
	if done == nil {
		t.Fatal("expected a CompactingEvent with Active=false")
	}
	if done.MicroOnly {
		t.Errorf("expected MicroOnly=false on a hard-truncate pass, got true")
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
	// Skip the LLM-summary tier: this test asserts on regex-extracted facts in
	// the hook payload, not on LLM summarization. Leaving it enabled makes
	// compactReactive fall through to a live provider.Stream against the
	// default unconfigured Anthropic provider (https://api.anthropic.com,
	// empty key → 401), which is non-hermetic and pollutes engine.log. The
	// fact-extraction tier under test is unaffected.
	cp.summaryEnabled = false

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
	// Skip the LLM-summary tier: this test asserts the facts slice is empty on
	// filler text, not on LLM summarization. Leaving it enabled makes
	// compactReactive fall through to a live provider.Stream against the
	// default unconfigured Anthropic provider (https://api.anthropic.com,
	// empty key → 401), which is non-hermetic and pollutes engine.log. The
	// fact-extraction tier under test is unaffected.
	cp.summaryEnabled = false

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

func TestIsMemoryCurrent_BoundaryInLatterHalf(t *testing.T) {
	conv := conversation.CreateConversation("test", "", "test-model")
	// Create 10 entries.
	for i := 0; i < 10; i++ {
		conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{Role: "user"})
	}

	// Boundary at entry index 7 (out of 10) — in the latter half.
	boundaryID := conv.Entries[7].ID
	if !isMemoryCurrent(conv, boundaryID) {
		t.Errorf("expected isMemoryCurrent=true for boundary at idx 7 of 10")
	}
}

func TestIsMemoryCurrent_BoundaryInFirstHalf(t *testing.T) {
	conv := conversation.CreateConversation("test", "", "test-model")
	// Create 10 entries.
	for i := 0; i < 10; i++ {
		conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{Role: "user"})
	}

	// Boundary at entry index 2 (out of 10) — in the first half, stale.
	boundaryID := conv.Entries[2].ID
	if isMemoryCurrent(conv, boundaryID) {
		t.Errorf("expected isMemoryCurrent=false for boundary at idx 2 of 10")
	}
}

func TestIsMemoryCurrent_EmptyBoundary(t *testing.T) {
	conv := conversation.CreateConversation("test", "", "test-model")
	conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{Role: "user"})

	if isMemoryCurrent(conv, "") {
		t.Error("expected isMemoryCurrent=false for empty boundary")
	}
}

func TestIsMemoryCurrent_BoundaryNotFound(t *testing.T) {
	conv := conversation.CreateConversation("test", "", "test-model")
	conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{Role: "user"})

	if isMemoryCurrent(conv, "nonexistent") {
		t.Error("expected isMemoryCurrent=false when boundary not found")
	}
}

func TestIsMemoryCurrent_NilEntries(t *testing.T) {
	conv := &conversation.Conversation{Entries: nil}

	if isMemoryCurrent(conv, "abc123") {
		t.Error("expected isMemoryCurrent=false when entries is nil")
	}
}

func TestIsMemoryCurrent_BoundaryAtMidpoint(t *testing.T) {
	conv := conversation.CreateConversation("test", "", "test-model")
	// Create 10 entries (midpoint = 5).
	for i := 0; i < 10; i++ {
		conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{Role: "user"})
	}

	// Boundary at the exact midpoint (idx 5) — should be current.
	boundaryID := conv.Entries[5].ID
	if !isMemoryCurrent(conv, boundaryID) {
		t.Errorf("expected isMemoryCurrent=true for boundary at midpoint idx 5 of 10")
	}
}

func TestIsMemoryCurrent_BoundaryJustBeforeMidpoint(t *testing.T) {
	conv := conversation.CreateConversation("test", "", "test-model")
	// Create 10 entries (midpoint = 5).
	for i := 0; i < 10; i++ {
		conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{Role: "user"})
	}

	// Boundary at idx 4 — just before midpoint, stale.
	boundaryID := conv.Entries[4].ID
	if isMemoryCurrent(conv, boundaryID) {
		t.Errorf("expected isMemoryCurrent=false for boundary at idx 4 of 10 (just before midpoint)")
	}
}

func TestCompactIfNeeded_SessionMemoryCoverageCheck(t *testing.T) {
	// When session memory has a stale boundary, compaction should reject the
	// stale memory and fall through to a fresher tier (regex facts /
	// truncation) instead of using it.
	b := NewApiBackend()
	_ = captureEvents(b, "stale-mem")

	conv := conversation.CreateConversation("stale-mem", "", "test-model")
	// Create entries so we can test boundary checking.
	for i := 0; i < 20; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
		conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{Role: "user"})
		conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{Role: "assistant"})
	}

	// Force tokens above the limit.
	conv.LastInputTokens = 180_000
	conv.LastInputTokensMsgCount = len(conv.Messages)

	run := &activeRun{requestID: "stale-mem", conv: conv}
	ctx := context.Background()
	cp := testCompactParams()
	// Skip the LLM-summary tier: this test asserts that stale session memory
	// is rejected and compaction falls through to a fresher tier, not that the
	// LLM tier specifically produced the result. Leaving it enabled makes
	// compactIfNeeded fall through to a live provider.Stream against the
	// default unconfigured Anthropic provider (https://api.anthropic.com,
	// empty key → 401), which is non-hermetic and pollutes engine.log. The
	// fall-through to the regex/truncation tier still proves stale memory was
	// not used.
	cp.summaryEnabled = false
	staleBoundaryID := conv.Entries[2].ID
	cp.getSessionMemory = func() string { return "stale iOS theme summary" }
	cp.getLastSummarizedEntryID = func() string { return staleBoundaryID }

	var capturedSessionMemory string
	hooks := RunHooks{
		OnSessionCompact: func(_ string, info interface{}) {
			if m, ok := info.(map[string]interface{}); ok {
				if sm, ok := m["sessionMemory"].(string); ok {
					capturedSessionMemory = sm
				}
			}
		},
	}

	b.compactIfNeeded(ctx, run, conv, hooks, 200_000, 100_000, cp)

	// The stale session memory should NOT have been used.
	if capturedSessionMemory == "stale iOS theme summary" {
		t.Error("stale session memory should not have been used when boundary is in the first half of entries")
	}
}
