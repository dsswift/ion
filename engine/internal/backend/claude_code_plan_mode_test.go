package backend

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// planModeTestBackend returns a backend whose normalized events are collected.
func planModeTestBackend() (*ClaudeCodeBackend, *[]types.NormalizedEvent) {
	b := NewClaudeCodeBackend()
	var events []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		events = append(events, ev)
	})
	return b, &events
}

// exitPlanModeAssistant builds a TaskUpdateEvent carrying an ExitPlanMode
// tool_use whose input holds the given plan text.
func exitPlanModeAssistant(plan string) *types.TaskUpdateEvent {
	return &types.TaskUpdateEvent{Message: types.AssistantMessagePayload{
		Content: []types.ContentBlock{
			{Type: "text", Text: "here is the plan"},
			{Type: "tool_use", Name: "ExitPlanMode", ID: "tu-1", Input: map[string]any{"plan": plan}},
		},
	}}
}

func TestClaudeCodePlanCapture_FromExitPlanModeArg(t *testing.T) {
	b, events := planModeTestBackend()
	planPath := filepath.Join(t.TempDir(), "swift-plan.md")
	run := &claudeCodeRun{requestID: "req-1", planMode: true, planFilePath: planPath}

	b.handlePlanModeAssistant(run, exitPlanModeAssistant("# The Plan\n\nsteps\n"))

	if !run.planCaptured {
		t.Fatal("planCaptured not latched after native capture")
	}
	data, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("plan file not written from ExitPlanMode arg: %v", err)
	}
	if string(data) != "# The Plan\n\nsteps\n" {
		t.Fatalf("plan file content mismatch: %q", string(data))
	}
	if len(*events) != 2 {
		t.Fatalf("expected PlanFileWritten + PlanProposal, got %d events", len(*events))
	}
	if _, ok := (*events)[0].Data.(*types.PlanFileWrittenEvent); !ok {
		t.Fatalf("event[0] = %T, want PlanFileWrittenEvent", (*events)[0].Data)
	}
	proposal, ok := (*events)[1].Data.(*types.PlanProposalEvent)
	if !ok || proposal.Kind != "exit" || proposal.PlanFilePath != planPath {
		t.Fatalf("event[1] wrong: %#v", (*events)[1].Data)
	}
}

func TestClaudeCodePlanCapture_NoPlanTextIsNoOp(t *testing.T) {
	b, events := planModeTestBackend()
	planPath := filepath.Join(t.TempDir(), "p.md")
	run := &claudeCodeRun{requestID: "req-2", planMode: true, planFilePath: planPath}

	b.handlePlanModeAssistant(run, exitPlanModeAssistant(""))

	if run.planCaptured {
		t.Fatal("planCaptured latched despite empty plan text")
	}
	if len(*events) != 0 {
		t.Fatalf("no events expected, got %d", len(*events))
	}
}

func TestClaudeCodePlanResult_EnrichesDenialWithoutDuplicateProposal(t *testing.T) {
	b, events := planModeTestBackend()
	planPath := filepath.Join(t.TempDir(), "p.md")
	run := &claudeCodeRun{requestID: "req-3", planMode: true, planFilePath: planPath, planCaptured: true}
	e := &types.TaskCompleteEvent{PermissionDenials: []types.PermissionDenial{
		{ToolName: "ExitPlanMode", ToolUseID: "tu-1"},
	}}

	b.handlePlanModeResult(run, e, &types.RunOptions{})

	got, _ := e.PermissionDenials[0].ToolInput["planFilePath"].(string)
	if got != planPath {
		t.Fatalf("denial not enriched with plan path: %v", e.PermissionDenials[0].ToolInput)
	}
	// Proposal already surfaced at capture time — emitting it again here would
	// double-render the approval card.
	if len(*events) != 0 {
		t.Fatalf("expected no duplicate events, got %d", len(*events))
	}
}

func TestClaudeCodePlanResult_FallbackProposalWhenCaptureNeverFired(t *testing.T) {
	b, events := planModeTestBackend()
	planPath := filepath.Join(t.TempDir(), "p.md")
	run := &claudeCodeRun{requestID: "req-4", planMode: true, planFilePath: planPath}
	e := &types.TaskCompleteEvent{PermissionDenials: []types.PermissionDenial{
		{ToolName: "ExitPlanMode", ToolUseID: "tu-1"},
	}}

	b.handlePlanModeResult(run, e, &types.RunOptions{})

	if len(*events) != 1 {
		t.Fatalf("expected exactly the fallback proposal, got %d events", len(*events))
	}
	proposal, ok := (*events)[0].Data.(*types.PlanProposalEvent)
	if !ok || proposal.Kind != "exit" || proposal.PlanFilePath != planPath {
		t.Fatalf("fallback proposal wrong: %#v", (*events)[0].Data)
	}
}

func TestClaudeCodePlanResult_AutoExitSynthesisWhenNoExitCall(t *testing.T) {
	b, events := planModeTestBackend()
	planPath := filepath.Join(t.TempDir(), "p.md")
	run := &claudeCodeRun{requestID: "req-5", planMode: true, planFilePath: planPath}
	e := &types.TaskCompleteEvent{} // turn ended, no ExitPlanMode denial

	b.handlePlanModeResult(run, e, &types.RunOptions{})

	if len(*events) != 2 {
		t.Fatalf("expected PlanModeAutoExit + PlanProposal, got %d events", len(*events))
	}
	auto, ok := (*events)[0].Data.(*types.PlanModeAutoExitEvent)
	if !ok || auto.RunID != "req-5" || auto.PlanFilePath != planPath {
		t.Fatalf("event[0] wrong: %#v", (*events)[0].Data)
	}
	if _, ok := (*events)[1].Data.(*types.PlanProposalEvent); !ok {
		t.Fatalf("event[1] = %T, want PlanProposalEvent", (*events)[1].Data)
	}
}

func TestClaudeCodePlanResult_AutoExitDisabledByRunOptions(t *testing.T) {
	b, events := planModeTestBackend()
	run := &claudeCodeRun{requestID: "req-6", planMode: true, planFilePath: filepath.Join(t.TempDir(), "p.md")}
	e := &types.TaskCompleteEvent{}
	off := false

	b.handlePlanModeResult(run, e, &types.RunOptions{PlanModeAutoExit: &off})

	if len(*events) != 0 {
		t.Fatalf("auto-exit fired despite PlanModeAutoExit=false: %d events", len(*events))
	}
}
