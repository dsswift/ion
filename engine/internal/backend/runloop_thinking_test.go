package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// thinkingStreamSeq builds a representative reasoning turn: a thinking block
// that streams two text deltas and one signature delta, then a tool_use turn,
// then end. This is the canonical Anthropic extended-thinking shape.
func thinkingStreamSeq() []types.LlmStreamEvent {
	return []types.LlmStreamEvent{
		{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m1", Model: "test"}},
		// Thinking block.
		{Type: "content_block_start", BlockIndex: 0, ContentBlock: &types.LlmStreamContentBlock{Type: "thinking"}},
		{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "thinking_delta", Thinking: "Let me consider "}},
		{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "thinking_delta", Thinking: "the approach here."}},
		{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "signature_delta", Thinking: "SIGNATURE_NOT_DISPLAY"}},
		{Type: "content_block_stop", BlockIndex: 0},
		// Text block.
		{Type: "content_block_start", BlockIndex: 1, ContentBlock: &types.LlmStreamContentBlock{Type: "text"}},
		{Type: "content_block_delta", BlockIndex: 1, Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "Here is my answer."}},
		{Type: "content_block_stop", BlockIndex: 1},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: strPtr("end_turn")}},
	}
}

// TestProcessStreamThinkingEvents pins the core of issue #158: a thinking block
// must emit ThinkingBlockStartEvent, ThinkingDeltaEvent per text delta, and
// ThinkingBlockEndEvent — in order — and must NOT emit a delta event for a
// signature_delta (which is not display text). The block_end must carry the
// estimated token total. The reasoning text must also accumulate into the
// persisted block's Thinking field.
func TestProcessStreamThinkingEvents(t *testing.T) {
	b := NewApiBackend()
	// run.opts default (nil Thinking) ⇒ streamDeltas ON.
	run := &activeRun{requestID: "think-1", opts: &types.RunOptions{}}
	captured := captureEvents(b, "think-1")

	events, errc := streamEventChan(thinkingStreamSeq())
	blocks, stopReason, _, err := b.processStream(context.Background(), run, events, errc)
	if err != nil {
		t.Fatalf("processStream error: %v", err)
	}
	if stopReason != "end_turn" {
		t.Fatalf("stopReason = %q, want end_turn", stopReason)
	}

	// Walk the captured events asserting the thinking sub-sequence.
	var (
		sawStart      bool
		deltaTexts    []string
		sawEnd        bool
		endEvt        *types.ThinkingBlockEndEvent
		startIdx      = -1
		endIdx        = -1
		firstDeltaIdx = -1
	)
	for i, ev := range *captured {
		switch e := ev.Data.(type) {
		case *types.ThinkingBlockStartEvent:
			sawStart = true
			startIdx = i
		case *types.ThinkingDeltaEvent:
			deltaTexts = append(deltaTexts, e.Text)
			if firstDeltaIdx == -1 {
				firstDeltaIdx = i
			}
		case *types.ThinkingBlockEndEvent:
			sawEnd = true
			endEvt = e
			endIdx = i
		}
	}

	if !sawStart {
		t.Fatalf("no ThinkingBlockStartEvent emitted")
	}
	if !sawEnd {
		t.Fatalf("no ThinkingBlockEndEvent emitted")
	}
	// Exactly two text deltas; the signature_delta must NOT have produced one.
	if len(deltaTexts) != 2 {
		t.Fatalf("ThinkingDeltaEvent count = %d, want 2 (signature_delta must not emit a delta); got %v", len(deltaTexts), deltaTexts)
	}
	if deltaTexts[0] != "Let me consider " || deltaTexts[1] != "the approach here." {
		t.Fatalf("delta texts = %v, want the two thinking_delta chunks (no signature text)", deltaTexts)
	}
	// Order: start < first delta < end.
	if startIdx >= firstDeltaIdx || firstDeltaIdx >= endIdx {
		t.Fatalf("event order wrong: start=%d firstDelta=%d end=%d (want start<delta<end)", startIdx, firstDeltaIdx, endIdx)
	}
	// block_end carries an estimated token total. Accumulated thinking text is
	// len("Let me consider the approach here.") = 34 → 34/4 = 8.
	if endEvt.Redacted {
		t.Fatalf("ThinkingBlockEndEvent.Redacted = true, want false for a normal thinking block")
	}
	if endEvt.TotalTokens != 8 {
		t.Fatalf("ThinkingBlockEndEvent.TotalTokens = %d, want 8 (34 chars / 4)", endEvt.TotalTokens)
	}

	// Reasoning text must accumulate into the persisted block for history /
	// persistThinking retention.
	if len(blocks) < 1 || blocks[0].Type != "thinking" {
		t.Fatalf("blocks[0] is not the thinking block: %+v", blocks)
	}
	if blocks[0].Thinking != "Let me consider the approach here." {
		t.Fatalf("blocks[0].Thinking = %q, want the accumulated reasoning text", blocks[0].Thinking)
	}

	// The run's thinking-token accumulator must reflect the estimate for
	// DispatchAgentResult.ThinkingTokens.
	if got := run.thinkingTokens.Load(); got != 8 {
		t.Fatalf("run.thinkingTokens = %d, want 8", got)
	}
}

// TestProcessStreamThinkingStreamDeltasOff pins invariant #2: when
// ThinkingConfig.StreamDeltas is explicitly false, the boundaries
// (ThinkingBlockStartEvent / ThinkingBlockEndEvent) STILL emit, but no
// ThinkingDeltaEvent is emitted. Liveness and the block summary survive.
func TestProcessStreamThinkingStreamDeltasOff(t *testing.T) {
	b := NewApiBackend()
	off := false
	run := &activeRun{requestID: "think-off", opts: &types.RunOptions{
		Thinking: &types.ThinkingConfig{StreamDeltas: &off},
	}}
	captured := captureEvents(b, "think-off")

	events, errc := streamEventChan(thinkingStreamSeq())
	if _, _, _, err := b.processStream(context.Background(), run, events, errc); err != nil {
		t.Fatalf("processStream error: %v", err)
	}

	var sawStart, sawEnd bool
	deltaCount := 0
	for _, ev := range *captured {
		switch ev.Data.(type) {
		case *types.ThinkingBlockStartEvent:
			sawStart = true
		case *types.ThinkingDeltaEvent:
			deltaCount++
		case *types.ThinkingBlockEndEvent:
			sawEnd = true
		}
	}
	if !sawStart || !sawEnd {
		t.Fatalf("boundaries must always emit: start=%t end=%t", sawStart, sawEnd)
	}
	if deltaCount != 0 {
		t.Fatalf("ThinkingDeltaEvent count = %d, want 0 when StreamDeltas=false", deltaCount)
	}
}

// TestProcessStreamRedactedThinking pins invariant #4: a redacted_thinking
// block emits ThinkingBlockStartEvent and a ThinkingBlockEndEvent with
// Redacted=true and TotalTokens=0, and produces no ThinkingDeltaEvent.
func TestProcessStreamRedactedThinking(t *testing.T) {
	b := NewApiBackend()
	run := &activeRun{requestID: "think-redacted", opts: &types.RunOptions{}}
	captured := captureEvents(b, "think-redacted")

	evs := []types.LlmStreamEvent{
		{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m1", Model: "test"}},
		{Type: "content_block_start", BlockIndex: 0, ContentBlock: &types.LlmStreamContentBlock{Type: "redacted_thinking"}},
		{Type: "content_block_stop", BlockIndex: 0},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: strPtr("end_turn")}},
	}

	events, errc := streamEventChan(evs)
	if _, _, _, err := b.processStream(context.Background(), run, events, errc); err != nil {
		t.Fatalf("processStream error: %v", err)
	}

	var sawStart bool
	var endEvt *types.ThinkingBlockEndEvent
	deltaCount := 0
	for _, ev := range *captured {
		switch e := ev.Data.(type) {
		case *types.ThinkingBlockStartEvent:
			sawStart = true
		case *types.ThinkingDeltaEvent:
			deltaCount++
		case *types.ThinkingBlockEndEvent:
			endEvt = e
		}
	}
	if !sawStart {
		t.Fatalf("redacted_thinking must emit ThinkingBlockStartEvent")
	}
	if deltaCount != 0 {
		t.Fatalf("redacted_thinking must emit no ThinkingDeltaEvent, got %d", deltaCount)
	}
	if endEvt == nil {
		t.Fatalf("redacted_thinking must emit ThinkingBlockEndEvent")
	}
	if !endEvt.Redacted {
		t.Fatalf("ThinkingBlockEndEvent.Redacted = false, want true for redacted_thinking")
	}
	if endEvt.TotalTokens != 0 {
		t.Fatalf("ThinkingBlockEndEvent.TotalTokens = %d, want 0 for redacted block", endEvt.TotalTokens)
	}
}

// --- Phase 2: persist-thinking gate + config resolution (issue #158) ---

// TestThinkingConfigResolution pins the default-ON pointer-bool semantics for
// both gates: nil config ⇒ on, nil pointer ⇒ on, explicit value ⇒ that value.
func TestThinkingConfigResolution(t *testing.T) {
	tru := true
	fls := false

	cases := []struct {
		name        string
		cfg         *types.ThinkingConfig
		wantStream  bool
		wantPersist bool
	}{
		{"nil config", nil, true, true},
		{"nil pointers", &types.ThinkingConfig{}, true, true},
		{"explicit true", &types.ThinkingConfig{StreamDeltas: &tru, Persist: &tru}, true, true},
		{"explicit false", &types.ThinkingConfig{StreamDeltas: &fls, Persist: &fls}, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := thinkingStreamDeltasEnabled(tc.cfg); got != tc.wantStream {
				t.Errorf("thinkingStreamDeltasEnabled = %t, want %t", got, tc.wantStream)
			}
			if got := thinkingPersistEnabled(tc.cfg); got != tc.wantPersist {
				t.Errorf("thinkingPersistEnabled = %t, want %t", got, tc.wantPersist)
			}
		})
	}
}

// TestStripThinkingText pins that stripThinkingText zeroes reasoning text on
// thinking / redacted_thinking blocks, keeps the block, leaves other blocks
// untouched, and does not mutate the input slice.
func TestStripThinkingText(t *testing.T) {
	in := []types.LlmContentBlock{
		{Type: "thinking", Thinking: "secret reasoning"},
		{Type: "redacted_thinking", Thinking: "x"},
		{Type: "text", Text: "answer"},
	}
	out := stripThinkingText(in)

	if out[0].Type != "thinking" || out[0].Thinking != "" {
		t.Errorf("thinking block: want kept with empty text, got %+v", out[0])
	}
	if out[1].Type != "redacted_thinking" || out[1].Thinking != "" {
		t.Errorf("redacted block: want kept with empty text, got %+v", out[1])
	}
	if out[2].Text != "answer" {
		t.Errorf("text block must be untouched, got %+v", out[2])
	}
	// Input must not be mutated (the live assistantBlocks keep their text).
	if in[0].Thinking != "secret reasoning" {
		t.Errorf("stripThinkingText mutated its input: %+v", in[0])
	}
}

// TestBlocksForPersistence pins the persist gate at the call-site helper:
// persist on (default / nil) keeps reasoning text; persist off strips it.
func TestBlocksForPersistence(t *testing.T) {
	b := NewApiBackend()
	blocks := []types.LlmContentBlock{
		{Type: "thinking", Thinking: "reasoning"},
		{Type: "text", Text: "answer"},
	}

	// Default (nil Thinking) ⇒ persist on ⇒ text retained.
	runOn := &activeRun{requestID: "persist-on", opts: &types.RunOptions{}}
	got := b.blocksForPersistence(runOn, blocks)
	if got[0].Thinking != "reasoning" {
		t.Errorf("persist on: reasoning text must be retained, got %q", got[0].Thinking)
	}

	// Explicit persist=false ⇒ text stripped, block kept.
	off := false
	runOff := &activeRun{requestID: "persist-off", opts: &types.RunOptions{
		Thinking: &types.ThinkingConfig{Persist: &off},
	}}
	got = b.blocksForPersistence(runOff, blocks)
	if got[0].Type != "thinking" || got[0].Thinking != "" {
		t.Errorf("persist off: want bare thinking block, got %+v", got[0])
	}
	if got[1].Text != "answer" {
		t.Errorf("persist off: text block must survive, got %+v", got[1])
	}
	// Original must be untouched.
	if blocks[0].Thinking != "reasoning" {
		t.Errorf("blocksForPersistence mutated input: %+v", blocks[0])
	}
}
