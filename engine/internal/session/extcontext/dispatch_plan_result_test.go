package extcontext

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// planEmittingChildBackend is a mock RunBackend that emits a PlanProposalEvent
// followed by a TaskCompleteEvent and exits cleanly. Used to exercise the
// dispatch_agent.go code paths that populate childPlanFilePath / childPlanExited
// (lines 402-410 and 562-563 of dispatch_agent.go).
type planEmittingChildBackend struct {
	mu       sync.Mutex
	onNorm   func(runID string, event types.NormalizedEvent)
	onExit   func(runID string, code *int, signal *string, sessionID string)
	onErr    func(runID string, err error)
	planPath string
	planSlug string
}

func (p *planEmittingChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	p.mu.Lock()
	p.onNorm = fn
	p.mu.Unlock()
}
func (p *planEmittingChildBackend) OnExit(fn func(string, *int, *string, string)) {
	p.mu.Lock()
	p.onExit = fn
	p.mu.Unlock()
}
func (p *planEmittingChildBackend) OnError(fn func(string, error)) {
	p.mu.Lock()
	p.onErr = fn
	p.mu.Unlock()
}
func (p *planEmittingChildBackend) Cancel(string) bool                     { return false }
func (p *planEmittingChildBackend) IsRunning(string) bool                  { return false }
func (p *planEmittingChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (p *planEmittingChildBackend) FlushConversations()                    {}
func (p *planEmittingChildBackend) Capabilities() backend.BackendCapabilities {
	return backend.BackendCapabilities{
		Kind:         "mock",
		ContextModel: backend.ContextModelEngineOwned,
		PlanMode:     true,
		Steering:     true,
	}
}

func (p *planEmittingChildBackend) StartRun(requestID string, _ types.RunOptions) {
	p.mu.Lock()
	onNorm, onExit, planPath, planSlug := p.onNorm, p.onExit, p.planPath, p.planSlug
	p.mu.Unlock()

	go func() {
		time.Sleep(5 * time.Millisecond)
		// Emit PlanProposalEvent -- this is the signal that the child called
		// ExitPlanMode and wrote a plan file. dispatch_agent.go sets
		// childPlanExited=true and childPlanFilePath from this event.
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.PlanProposalEvent{
				PlanFilePath: planPath,
				PlanSlug:     planSlug,
			}})
		}
		// Terminal TaskCompleteEvent so runChild can exit cleanly.
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
				Result: "plan written",
			}})
		}
		if onExit != nil {
			zero := 0
			onExit(requestID, &zero, nil, "plan-test-conv")
		}
	}()
}

// TestDispatchAgentResult_PlanFields verifies that when a child session emits a
// PlanProposalEvent, the returned DispatchAgentResult carries a non-empty
// PlanFilePath and PlanExited==true.
//
// This covers dispatch_agent.go lines 402-410 (the PlanProposalEvent branch in
// the OnNormalized switch) and lines 562-563 (PlanFilePath/PlanExited on the
// result struct). Previously zero coverage because no test exercised the
// PlanProposalEvent path through the full dispatch plumbing.
func TestDispatchAgentResult_PlanFields(t *testing.T) {
	const wantPath = "/tmp/plans/my-plan.md"
	const wantSlug = "my-plan"

	child := &planEmittingChildBackend{planPath: wantPath, planSlug: wantSlug}
	acc := &bumpCountingAccessor{child: child}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	result, err := dispatchFn(extension.DispatchAgentOpts{
		Name:     "plan-agent",
		Task:     "write a plan",
		PlanMode: true,
	})
	if err != nil {
		t.Fatalf("dispatch returned error: %v", err)
	}
	if result == nil {
		t.Fatal("dispatch returned nil result")
	}

	if result.PlanFilePath != wantPath {
		t.Errorf("PlanFilePath = %q, want %q", result.PlanFilePath, wantPath)
	}
	if !result.PlanExited {
		t.Errorf("PlanExited = false, want true (child emitted PlanProposalEvent)")
	}
}

// TestDispatchAgentResult_NoPlanFields verifies that a dispatch whose child
// does NOT emit PlanProposalEvent leaves PlanFilePath empty and PlanExited
// false (regression guard: plan fields must not bleed across dispatches).
func TestDispatchAgentResult_NoPlanFields(t *testing.T) {
	// Use the existing drippingChildBackend which only emits TextChunkEvents.
	child := &drippingChildBackend{numEvents: 2}
	acc := &bumpCountingAccessor{child: child}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	result, err := dispatchFn(extension.DispatchAgentOpts{
		Name: "no-plan-agent",
		Task: "just do work, no plan",
	})
	if err != nil {
		t.Fatalf("dispatch returned error: %v", err)
	}
	if result == nil {
		t.Fatal("dispatch returned nil result")
	}

	if result.PlanFilePath != "" {
		t.Errorf("PlanFilePath = %q, want empty for a non-plan dispatch", result.PlanFilePath)
	}
	if result.PlanExited {
		t.Errorf("PlanExited = true, want false for a non-plan dispatch")
	}
}
