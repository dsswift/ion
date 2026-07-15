package backend

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestExecuteTools_HumanWaitSurvivesToolDeadline is the regression test for the
// reported bug: a tool that blocks on a human (simulated by pausing the
// DeadlineSuspender carried on the tool ctx) past the finite tool timeout must
// NOT be cancelled at the deadline. With a short configured tool timeout, the
// tool "waits on a human" longer than the timeout, then completes successfully.
//
// Revert-check: if the router did NOT pause the suspender (the pre-Option-B
// behavior), the tool ctx would be cancelled at toolDefaultMs and the result
// would carry the deadline-exceeded error — the assertion on a clean result
// goes red.
func TestExecuteTools_HumanWaitSurvivesToolDeadline(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	const shortToolTimeout = 100 // ms — much shorter than the simulated human-wait
	humanWait := 300 * time.Millisecond

	router := func(ctx context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
		ds := types.DeadlineSuspenderFrom(ctx)
		// Enter human-wait: suspend the finite tool deadline.
		ds.Pause()
		defer ds.Resume()
		// Block longer than the tool timeout would allow.
		select {
		case <-time.After(humanWait):
		case <-ctx.Done():
			// If the deadline fired despite the pause, surface it as an error
			// so the test can detect the regression.
			return nil, ctx.Err()
		}
		return &types.ToolResult{Content: "human answered"}, nil
	}

	run := &activeRun{
		requestID: "test-human-wait",
		cfg: &RunConfig{
			McpToolRouter: router,
			Timeouts:      &types.TimeoutsConfig{ToolDefaultMs: shortToolTimeout},
		},
	}

	blocks := []types.LlmContentBlock{{Name: "ext_tool_that_elicits", ID: "tc-1", Input: map[string]interface{}{}}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}
	if results[0].IsError {
		t.Fatalf("tool errored — human-wait was capped by the tool deadline: %q", results[0].Content)
	}
	if !strings.Contains(results[0].Content, "human answered") {
		t.Errorf("result = %q, want human-answered content", results[0].Content)
	}
}

// TestExecuteTools_NonElicitingToolStillTimesOut pins that Option B did not
// silently become Option A (blanket exemption): a tool that NEVER pauses the
// suspender still hits the finite tool deadline and returns the timeout error.
func TestExecuteTools_NonElicitingToolStillTimesOut(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	const shortToolTimeout = 100 // ms

	router := func(ctx context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
		// Machine work that ignores ctx and runs well past the deadline,
		// WITHOUT pausing the suspender. The deadline must fire.
		select {
		case <-time.After(2 * time.Second):
			return &types.ToolResult{Content: "should not reach here"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	run := &activeRun{
		requestID: "test-no-elicit",
		cfg: &RunConfig{
			McpToolRouter: router,
			Timeouts:      &types.TimeoutsConfig{ToolDefaultMs: shortToolTimeout},
		},
	}

	blocks := []types.LlmContentBlock{{Name: "slow_machine_tool", ID: "tc-1", Input: map[string]interface{}{}}}
	start := time.Now()
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}
	if !results[0].IsError {
		t.Error("expected non-eliciting slow tool to time out, but it succeeded — finite ceiling lost")
	}
	if !strings.Contains(results[0].Content, "deadline") {
		t.Errorf("result = %q, want a deadline-exceeded message", results[0].Content)
	}
	if elapsed > 1500*time.Millisecond {
		t.Errorf("tool took %s — deadline did not fire near the configured %dms", elapsed, shortToolTimeout)
	}
}
