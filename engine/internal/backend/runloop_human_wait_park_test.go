package backend

// Tests for the human-wait client-tool PARK path (runloop_tools.go): calling
// a tool named in RunConfig.HumanWaitClientTools must terminate the run with
// a retained PermissionDenial carrying the full tool input — the
// AskUserQuestion sentinel treatment — and must NEVER route the call through
// the blocking McpToolRouter. This is what lets a structured question round
// survive stop, navigation, and engine restart: nothing is running while the
// user decides.

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestExecuteTools_HumanWaitClientToolParksRun pins the park: the run is
// flagged terminal (exitPlanMode), the denial carries the tool name/id/full
// input, a placeholder result lands, and the router is never invoked.
//
// Revert-check: with the HumanWaitClientTools interception removed, the call
// falls through to the router (routerCalls != 0) and no denial is recorded —
// both assertions go red.
func TestExecuteTools_HumanWaitClientToolParksRun(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	var routerCalls atomic.Int32
	router := func(_ context.Context, _ string, _ map[string]interface{}) (*types.ToolResult, error) {
		routerCalls.Add(1)
		return &types.ToolResult{Content: "should never run"}, nil
	}

	run := &activeRun{
		requestID: "test-hw-park",
		cfg: &RunConfig{
			McpToolRouter:        router,
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
		},
	}

	input := map[string]interface{}{
		"title": "Verification",
		"questions": []interface{}{
			map[string]interface{}{"id": "q1", "prompt": "Did it render?", "mode": "text"},
		},
	}
	blocks := []types.LlmContentBlock{{Type: "tool_use", Name: "AskUserQuestions", ID: "tu-1", Input: input}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}

	if routerCalls.Load() != 0 {
		t.Fatal("human-wait tool must park the run, never route through the blocking wire round-trip")
	}

	run.mu.Lock()
	parked := run.parkedHumanWait
	planExit := run.exitPlanMode
	denials := run.permissionDenials
	run.mu.Unlock()
	if !parked {
		t.Fatal("run must be flagged parkedHumanWait so the loop wraps up")
	}
	// The park must NOT borrow plan-mode's flag: doing so made the run report
	// "plan mode exited" and wrote "Plan mode exited." into the transcript of
	// every guided-questions round.
	if planExit {
		t.Error("park must not set exitPlanMode — it is not a plan-mode exit")
	}
	if len(denials) != 1 {
		t.Fatalf("want exactly 1 retained denial, got %d", len(denials))
	}
	d := denials[0]
	if d.ToolName != "AskUserQuestions" || d.ToolUseID != "tu-1" {
		t.Errorf("denial identity wrong: %+v", d)
	}
	// The FULL input must survive on the denial: it is what the client
	// re-renders after reconnect/restart.
	if d.ToolInput["title"] != "Verification" {
		t.Errorf("denial must retain the full tool input, got %+v", d.ToolInput)
	}
	if results[0].IsError || results[0].Content == "" {
		t.Errorf("placeholder tool result expected, got %+v", results[0])
	}
}

// TestExecuteTools_MachineClientToolStillRoutes pins the boundary: a client
// tool NOT named in HumanWaitClientTools keeps the blocking router path.
func TestExecuteTools_MachineClientToolStillRoutes(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	var routerCalls atomic.Int32
	router := func(_ context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
		routerCalls.Add(1)
		return &types.ToolResult{Content: "machine result for " + name}, nil
	}

	run := &activeRun{
		requestID: "test-machine-routes",
		cfg: &RunConfig{
			McpToolRouter:        router,
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
			ExternalTools:        []types.LlmToolDef{{Name: "BenchMemberFile"}},
		},
	}

	blocks := []types.LlmContentBlock{{Type: "tool_use", Name: "BenchMemberFile", ID: "tu-2", Input: map[string]interface{}{}}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}
	if routerCalls.Load() != 1 {
		t.Fatalf("machine tool must route through the wire round-trip, calls=%d", routerCalls.Load())
	}
	run.mu.Lock()
	parked := run.parkedHumanWait
	run.mu.Unlock()
	if parked {
		t.Fatal("machine tool must not park the run")
	}
	if results[0].IsError {
		t.Errorf("machine result expected, got %+v", results[0])
	}
}

// TestExecuteTools_HumanWaitRefusesSiblingCalls pins the terminal-handoff
// contract: a human-wait tool ENDS the turn, so any sibling tool call in the
// same model response is refused BEFORE it executes.
//
// The defect this closes: tool calls run in parallel, so a model that paired
// AskUserQuestions with more work had those siblings race the park — real
// side effects landing after the run was terminal, results discarded, and the
// model reading its own turn as still in progress (so a requested
// continuation page was never re-issued while the operator's submitted
// answers waited for it).
//
// Revert-check: without the pre-scan, the sibling's executor runs and
// siblingRan flips true.
func TestExecuteTools_HumanWaitRefusesSiblingCalls(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	var siblingRan atomic.Bool
	router := func(_ context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
		if name == "BenchMemberFile" {
			siblingRan.Store(true)
		}
		return &types.ToolResult{Content: "sibling result"}, nil
	}

	run := &activeRun{
		requestID: "test-hw-siblings",
		cfg: &RunConfig{
			McpToolRouter:        router,
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
			ExternalTools:        []types.LlmToolDef{{Name: "BenchMemberFile"}},
		},
	}

	// The model pairs the question with another tool call in ONE response.
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", Name: "AskUserQuestions", ID: "tu-q", Input: map[string]interface{}{
			"title":     "Round 2",
			"questions": []interface{}{map[string]interface{}{"id": "q1", "prompt": "Deeper?", "mode": "text"}},
		}},
		{Type: "tool_use", Name: "BenchMemberFile", ID: "tu-s", Input: map[string]interface{}{}},
	}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}

	if siblingRan.Load() {
		t.Fatal("sibling tool executed alongside a human-wait park: its side effects would land after the run is terminal")
	}

	run.mu.Lock()
	parked := run.parkedHumanWait
	denials := run.permissionDenials
	run.mu.Unlock()
	if !parked {
		t.Fatal("the run must still park when the question shares its turn")
	}
	if len(denials) != 1 || denials[0].ToolName != "AskUserQuestions" {
		t.Fatalf("the question must be retained exactly once, got %+v", denials)
	}

	// The sibling gets a non-error result explaining why, so the model can
	// re-issue it after the user answers rather than treating it as a failure.
	if results[1].IsError {
		t.Errorf("sibling refusal must not be a tool error, got %+v", results[1])
	}
	if !strings.Contains(results[1].Content, "Re-issue this call after the user answers") {
		t.Errorf("sibling refusal must say how to proceed, got %q", results[1].Content)
	}
}

// TestExecuteTools_HumanWaitAloneStillParks guards the boundary: the
// pre-scan must not change the ordinary single-call case.
func TestExecuteTools_HumanWaitAloneStillParks(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	run := &activeRun{
		requestID: "test-hw-alone",
		cfg: &RunConfig{
			HumanWaitClientTools: map[string]bool{"AskUserQuestions": true},
		},
	}
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", Name: "AskUserQuestions", ID: "tu-1", Input: map[string]interface{}{
			"title":     "Solo",
			"questions": []interface{}{map[string]interface{}{"id": "q1", "prompt": "One?", "mode": "text"}},
		}},
	}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatalf("executeTools error: %v", err)
	}
	run.mu.Lock()
	parked := run.parkedHumanWait
	run.mu.Unlock()
	if !parked {
		t.Fatal("a lone human-wait call must still park")
	}
}
