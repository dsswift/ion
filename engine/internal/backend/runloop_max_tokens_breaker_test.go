package backend

import (
	"fmt"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// thinkingOnlyMaxTokensResponse builds a stream that emits ONLY a thinking
// block (no text, no tool_use) and then stops with reason max_tokens. This is
// the exact shape produced by the thinking-budget-exceeds-MaxTokens pathology:
// the model spends its entire output window on reasoning tokens, the provider
// truncates at max_tokens, and no usable output is ever produced.
func thinkingOnlyMaxTokensResponse(thinking string) []types.LlmStreamEvent {
	stopReason := "max_tokens"
	return []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID:    fmt.Sprintf("msg_%d", time.Now().UnixNano()),
				Model: "test-model",
				Usage: types.LlmUsage{InputTokens: 100},
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
			DeltaUsage: &types.LlmUsage{OutputTokens: 200},
		},
		{Type: "message_stop"},
	}
}

// TestMaxTokensThinkingOnlyCircuitBreaker pins the FINDING 3 fix: when every
// turn produces only thinking output and stops at max_tokens, the engine must
// terminate the run with an error after the default breaker cap (3), NOT keep
// injecting "Continue from where you left off." until max_turns is hit.
func TestMaxTokensThinkingOnlyCircuitBreaker(t *testing.T) {
	// Each Stream call returns a thinking-only max_tokens turn. The breaker
	// fires on the 3rd (default cap), so 3 scripted responses are enough; the
	// run must terminate before consuming a 4th. (The backend mock errors if
	// asked for a response past the scripted list, which would surface as a
	// distinct failure and never be mistaken for a clean breaker termination.)
	mock := setupTestProvider([][]types.LlmStreamEvent{
		thinkingOnlyMaxTokensResponse("reasoning with no conclusion..."),
		thinkingOnlyMaxTokensResponse("still reasoning, no conclusion..."),
		thinkingOnlyMaxTokensResponse("more reasoning, no conclusion..."),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-mt-breaker")

	// A generous MaxTurns so the run would loop far past the breaker cap if the
	// breaker did NOT fire. If the breaker works, it terminates at count=3 —
	// well before this ceiling.
	b.StartRun("req-mt-breaker", types.RunOptions{
		Prompt:      "go",
		ProjectPath: "/tmp",
		Model:       testModel,
		MaxTurns:    50,
		MaxTokens:   4096,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit (breaker likely did not fire)")
	}

	// Must exit non-zero (error termination), not the exit 0 that max_turns or
	// a clean completion would produce.
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 1 {
		t.Fatalf("expected exit 1 (circuit-breaker termination), got %d", *c.exitCode)
	}

	// The termination must be surfaced as an ErrorEvent carrying the breaker's
	// error code, so headless consumers can distinguish it from other failures.
	var breakerErr *types.ErrorEvent
	for _, ev := range c.normalized {
		if ee, ok := ev.Data.(*types.ErrorEvent); ok && ee.ErrorCode == "max_tokens_thinking_only_loop" {
			breakerErr = ee
			break
		}
	}
	if breakerErr == nil {
		t.Fatal("expected an ErrorEvent with code max_tokens_thinking_only_loop")
	}

	// The run must NOT have reached max_turns: a TaskCompleteEvent with a
	// "Reached max turns" result would mean the breaker never fired and the
	// loop ran to the ceiling.
	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			t.Fatalf("unexpected TaskCompleteEvent (breaker should terminate before completion): %q", tc.Result)
		}
	}

	// Provider must have been called exactly the cap number of times (3):
	// turns 1 and 2 increment the counter and inject a continuation; turn 3
	// hits the cap and terminates. A 4th call would mean the breaker fired
	// late.
	mock.mu.Lock()
	calls := mock.callCount
	mock.mu.Unlock()
	if calls != defaultMaxTokenThinkingOnlyBreaker {
		t.Errorf("provider call count: want %d (breaker cap), got %d", defaultMaxTokenThinkingOnlyBreaker, calls)
	}
}

// TestMaxTokensThinkingOnlyBreakerResetsOnRealOutput verifies the breaker does
// NOT fire when a max_tokens turn produces genuine (text) output: real
// truncation of useful work must still trigger the normal continuation path,
// and the consecutive-thinking-only counter must reset.
func TestMaxTokensThinkingOnlyBreakerResetsOnRealOutput(t *testing.T) {
	// Turn 1: thinking-only max_tokens (count → 1, continuation injected).
	// Turn 2: max_tokens WITH text output (counter resets to 0, continuation).
	// Turn 3: clean end_turn — run completes normally.
	setupTestProvider([][]types.LlmStreamEvent{
		thinkingOnlyMaxTokensResponse("pondering..."),
		maxTokensResponse("here is some real partial output"),
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-mt-reset")

	b.StartRun("req-mt-reset", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		MaxTurns:         50,
		MaxTokens:        4096,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0 (clean completion, breaker must not fire), got %d", *c.exitCode)
	}
	// No breaker ErrorEvent should have been emitted.
	for _, ev := range c.normalized {
		if ee, ok := ev.Data.(*types.ErrorEvent); ok && ee.ErrorCode == "max_tokens_thinking_only_loop" {
			t.Fatal("breaker fired despite an intervening real-output turn")
		}
	}
}
