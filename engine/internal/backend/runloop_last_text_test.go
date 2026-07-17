package backend

import (
	"fmt"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// thinkingOnlyEndTurnResponse builds a stream that emits ONLY a thinking block
// (no text, no tool_use) and then stops cleanly with reason end_turn. This is
// the "silent final turn" shape FINDING 6 targets: the model spends the turn
// reasoning and ends without any user-facing text, so TaskCompleteEvent.Result
// is empty even though earlier turns may have narrated work.
func thinkingOnlyEndTurnResponse(thinking string) []types.LlmStreamEvent {
	stopReason := "end_turn"
	return []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID:    fmt.Sprintf("msg_%d", time.Now().UnixNano()),
				Model: "test-model",
				Usage: types.LlmUsage{InputTokens: 10},
			},
		},
		{
			Type:       "content_block_start",
			BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{
				Type: "thinking",
			},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta: &types.LlmStreamDelta{
				Type:     "thinking_delta",
				Thinking: thinking,
			},
		},
		{Type: "content_block_stop", BlockIndex: 0},
		{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{
				Type:       "message_delta",
				StopReason: &stopReason,
			},
			DeltaUsage: &types.LlmUsage{OutputTokens: 5},
		},
		{Type: "message_stop"},
	}
}

// lastTaskComplete returns the final TaskCompleteEvent captured by the
// collector, or nil if none was emitted. The run loop emits exactly one
// TaskCompleteEvent per run, but scanning for the last one is robust against
// any future path that emits an intermediate one.
func lastTaskComplete(c *collectedEvents) *types.TaskCompleteEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	var found *types.TaskCompleteEvent
	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			found = tc
		}
	}
	return found
}

// TestTaskCompleteLastTextPopulated pins the FINDING 6 contract for the common
// case: when the final (and only) turn produces text, TaskCompleteEvent.Result
// and TaskCompleteEvent.LastText are both populated and equal. This is the
// invariant a consumer relies on to treat LastText as "Result, but never empty
// when the run produced any text at all."
func TestTaskCompleteLastTextPopulated(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("narration text", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-lasttext-populated")
	b.StartRun("req-lasttext-populated", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}

	tc := lastTaskComplete(c)
	if tc == nil {
		t.Fatal("no TaskCompleteEvent emitted")
	}
	if tc.Result != "narration text" {
		t.Errorf("Result: want %q, got %q", "narration text", tc.Result)
	}
	if tc.LastText != tc.Result {
		t.Errorf("LastText should equal Result when the final turn has text: Result=%q LastText=%q", tc.Result, tc.LastText)
	}
}

// TestTaskCompleteLastTextEmptyWhenNoText pins the other boundary: a run whose
// only turn is thinking-only (pure reasoning, end_turn) produces no text at
// all, so BOTH Result and LastText are empty. This distinguishes "silent run"
// (both empty) from "silent final turn" (Result empty, LastText populated),
// which the multi-turn test below exercises.
func TestTaskCompleteLastTextEmptyWhenNoText(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		thinkingOnlyEndTurnResponse("reasoning with no output"),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-lasttext-empty")
	b.StartRun("req-lasttext-empty", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}

	tc := lastTaskComplete(c)
	if tc == nil {
		t.Fatal("no TaskCompleteEvent emitted")
	}
	if tc.Result != "" {
		t.Errorf("Result: want empty for a thinking-only turn, got %q", tc.Result)
	}
	if tc.LastText != "" {
		t.Errorf("LastText: want empty when the run produced no text at all, got %q", tc.LastText)
	}
}

// TestTaskCompleteLastTextSurvivesSilentFinalTurn is the core FINDING 6
// regression test. It drives a two-turn run:
//
//	turn 1: text "important work done", end_turn — below the early-stop
//	        threshold, so the engine injects a continuation and re-runs.
//	turn 2: thinking-only, end_turn — the "silent final turn".
//
// On the unfixed code TaskCompleteEvent.Result is empty (the final turn had no
// text) and there is no LastText field, so a consumer cannot recover the
// "important work done" narration. With the fix, Result is empty but LastText
// carries "important work done" from turn 1.
//
// Reverting the LastText tracking (the `run.lastNonEmptyResultText = resultText`
// assignment plus the `LastText:` field on the emission) makes this test fail:
// LastText comes back empty.
func TestTaskCompleteLastTextSurvivesSilentFinalTurn(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("important work done", 10, 10),    // 10% of budget → continue
		thinkingOnlyEndTurnResponse("final reasoning"), // silent final turn
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-lasttext-silent-final")

	// Early-stop only continues when a hook supplies a ContinueMessage. Supply
	// it on the FIRST decision only so turn 1 continues into turn 2, then let
	// the engine's default (no message → stop) terminate the run after the
	// silent turn 2.
	var decisionCalls int
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnBeforeEarlyStopDecision: func(_ EarlyStopDecisionInfo) *EarlyStopDecisionResult {
				decisionCalls++
				if decisionCalls == 1 {
					return &EarlyStopDecisionResult{ContinueMessage: "test: keep working"}
				}
				return nil
			},
		},
	}
	budget := earlyStopBudget
	b.StartRunWithConfig("req-lasttext-silent-final", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  budget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}
	if c.exitCode == nil || *c.exitCode != 0 {
		t.Fatalf("expected exit 0 (two-turn completion), got %v", c.exitCode)
	}

	tc := lastTaskComplete(c)
	if tc == nil {
		t.Fatal("no TaskCompleteEvent emitted")
	}
	// The final turn was thinking-only, so Result is empty.
	if tc.Result != "" {
		t.Errorf("Result: want empty for a silent (thinking-only) final turn, got %q", tc.Result)
	}
	// LastText must carry the last non-empty text from turn 1.
	if tc.LastText != "important work done" {
		t.Errorf("LastText: want %q (recovered from turn 1), got %q", "important work done", tc.LastText)
	}
}
