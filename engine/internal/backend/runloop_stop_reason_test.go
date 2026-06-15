package backend

import (
	"fmt"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// customStopResponse builds a minimal single-turn stream that ends in the
// given stop reason, exercising the run loop's `switch stopReason` default
// branch for non-standard reasons.
func customStopResponse(stopReason string) []types.LlmStreamEvent {
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

// TestRunLoopErrorStopReasonEmitsErrorAndNonZeroExit pins Defect 2's
// belt-and-suspenders: a stop reason of "error" reaching the run loop default
// case must emit an ErrorEvent and exit non-zero, NOT a silent exit 0.
func TestRunLoopErrorStopReasonEmitsErrorAndNonZeroExit(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		customStopResponse("error"),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-error-stop")
	b.StartRun("req-error-stop", types.RunOptions{
		Prompt:           "trigger error stop",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	if c.exitCode == nil {
		t.Fatal("expected a non-nil exit code")
	}
	if *c.exitCode == 0 {
		t.Errorf("exit code = 0, want non-zero for an 'error' stop reason (the silent-exit-0 bug)")
	}

	foundError := false
	for _, ev := range c.normalized {
		if ee, ok := ev.Data.(*types.ErrorEvent); ok && ee.IsError {
			foundError = true
		}
	}
	if !foundError {
		t.Error("expected an ErrorEvent for an 'error' stop reason; none emitted")
	}
}

// TestRunLoopUnknownStopReasonExitsZero confirms the OTHER half of the default
// branch is preserved: a genuinely-unknown stop reason still completes with a
// clean exit 0 and emits no ErrorEvent. This pins the distinction so a future
// refactor cannot silently collapse the two branches.
func TestRunLoopUnknownStopReasonExitsZero(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		customStopResponse("weird_reason"),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-unknown-stop")
	b.StartRun("req-unknown-stop", types.RunOptions{
		Prompt:           "trigger unknown stop",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	if c.exitCode == nil || *c.exitCode != 0 {
		t.Errorf("exit code = %v, want 0 for a genuinely-unknown stop reason", c.exitCode)
	}

	for _, ev := range c.normalized {
		if ee, ok := ev.Data.(*types.ErrorEvent); ok && ee.IsError {
			t.Error("unknown (non-error) stop reason should NOT emit an ErrorEvent")
		}
	}
}
