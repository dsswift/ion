package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestTemporaryAutoPlanCompletionSynthesizesProposal(t *testing.T) {
	mgr := &Manager{sessions: map[string]*engineSession{"tab": {
		key: "tab", planMode: true, conversationID: "conv",
		temporaryAutoPlan: &temporaryAutoPlanWorkflow{runID: "run", planFile: "/tmp/plan.md"},
	}}}
	complete := &types.TaskCompleteEvent{Reason: types.TaskCompletionReasonNormal}
	events := mgr.completeTemporaryAutoPlanWorkflow("tab", "run", complete)
	if len(events) != 2 {
		t.Fatalf("events = %d, want auto-exit plus proposal", len(events))
	}
	if _, ok := events[0].Data.(*types.PlanModeAutoExitEvent); !ok {
		t.Fatalf("first event = %T", events[0].Data)
	}
	proposal, ok := events[1].Data.(*types.PlanProposalEvent)
	if !ok || proposal.Kind != "exit" || proposal.PlanFilePath != "/tmp/plan.md" {
		t.Fatalf("proposal = %#v", events[1].Data)
	}
	if len(complete.PermissionDenials) != 1 || complete.PermissionDenials[0].ToolName != "ExitPlanMode" {
		t.Fatalf("denials = %#v", complete.PermissionDenials)
	}
	if mgr.sessions["tab"].planMode != true {
		t.Fatal("temporary run changed session plan mode")
	}
	if mgr.sessions["tab"].temporaryAutoPlan != nil {
		t.Fatal("workflow not cleared")
	}
}

func TestTemporaryAutoPlanQuestionWaitsForAnswer(t *testing.T) {
	workflow := &temporaryAutoPlanWorkflow{runID: "run", planFile: "/tmp/plan.md"}
	mgr := &Manager{sessions: map[string]*engineSession{"tab": {key: "tab", planMode: true, temporaryAutoPlan: workflow}}}
	complete := &types.TaskCompleteEvent{Reason: types.TaskCompletionReasonNormal, PermissionDenials: []types.PermissionDenial{{ToolName: "AskUserQuestion"}}}
	if events := mgr.completeTemporaryAutoPlanWorkflow("tab", "run", complete); len(events) != 0 {
		t.Fatalf("events = %#v", events)
	}
	if !workflow.awaitingUser {
		t.Fatal("workflow did not retain question state")
	}
}

func TestTemporaryAutoPlanFailureDoesNotPropose(t *testing.T) {
	mgr := &Manager{sessions: map[string]*engineSession{"tab": {key: "tab", planMode: true, temporaryAutoPlan: &temporaryAutoPlanWorkflow{runID: "run", planFile: "/tmp/plan.md"}}}}
	complete := &types.TaskCompleteEvent{Reason: "error"}
	if events := mgr.completeTemporaryAutoPlanWorkflow("tab", "run", complete); len(events) != 0 {
		t.Fatalf("events = %#v", events)
	}
	if len(complete.PermissionDenials) != 0 {
		t.Fatalf("denials = %#v", complete.PermissionDenials)
	}
}

func TestTemporaryAutoPlanWaitsForBackgroundWorkThenProposes(t *testing.T) {
	registry := extcontext.NewDispatchRegistry()
	registry.Register("agent-1", func() {}, nil, "tab")
	workflow := &temporaryAutoPlanWorkflow{runID: "root-run", planFile: "/tmp/plan.md"}
	s := &engineSession{
		key: "tab", planMode: true, conversationID: "conv",
		dispatchRegistry: registry, temporaryAutoPlan: workflow,
	}
	mgr := &Manager{sessions: map[string]*engineSession{"tab": s}}

	rootComplete := &types.TaskCompleteEvent{Reason: types.TaskCompletionReasonNormal}
	if events := mgr.completeTemporaryAutoPlanWorkflow("tab", "root-run", rootComplete); len(events) != 0 {
		t.Fatalf("root completion proposed while child was active: %#v", events)
	}
	if !workflow.awaitingWork {
		t.Fatal("workflow did not remember outstanding work")
	}

	registry.Deregister("agent-1")
	continuationOpts := types.RunOptions{BackgroundWork: &types.BackgroundWorkInfo{
		Kind:  string(types.InjectionKindAgentCompletion),
		Items: []types.BackgroundWorkItem{{ID: "agent-1", Source: types.BackgroundWorkSourceAgent}},
	}}
	mgr.inheritTemporaryAutoPlanWorkflow(s, "tab", &continuationOpts)
	if !continuationOpts.TemporaryAutoFromPlan {
		t.Fatal("child-result continuation did not inherit temporary auto mode")
	}
	mgr.beginTemporaryAutoPlanWorkflow(s, "tab", "continuation-run", workflow.planFile)

	continuationComplete := &types.TaskCompleteEvent{Reason: types.TaskCompletionReasonNormal}
	events := mgr.completeTemporaryAutoPlanWorkflow("tab", "continuation-run", continuationComplete)
	if len(events) != 2 || len(continuationComplete.PermissionDenials) != 1 {
		t.Fatalf("final continuation did not propose: events=%d denials=%+v", len(events), continuationComplete.PermissionDenials)
	}
}
