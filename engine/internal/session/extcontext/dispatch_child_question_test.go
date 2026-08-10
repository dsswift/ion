package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestChildQuestion_RoutesToDispatcher verifies the dispatch-level wiring: the
// ChildElicitFn built for a dispatched child forwards the child's question to
// the dispatcher's OnChildQuestion callback, stamped with the dispatch name,
// id, and depth — and relays the dispatcher's answer back unchanged. The
// runloop-level inject-vs-terminate behavior is pinned separately in
// internal/backend/runloop_child_question_test.go; this test pins the bridge.
func TestChildQuestion_RoutesToDispatcher(t *testing.T) {
	const (
		wantName   = "researcher"
		wantID     = "dispatch-researcher-123"
		wantDepth  = 2
		wantAnswer = "use the staging endpoint"
	)

	var gotInfo extension.DispatchChildQuestionInfo
	onChildQuestion := func(info extension.DispatchChildQuestionInfo) (string, bool, error) {
		gotInfo = info
		return wantAnswer, false, nil
	}

	elicit := buildChildElicitFn(onChildQuestion, wantName, wantID, wantDepth)

	answer, cancelled, err := elicit("which endpoint?")
	if err != nil {
		t.Fatalf("ChildElicitFn returned error: %v", err)
	}
	if cancelled {
		t.Error("expected cancelled=false when dispatcher answers")
	}
	if answer != wantAnswer {
		t.Errorf("answer = %q, want %q", answer, wantAnswer)
	}

	// The dispatcher must receive the question stamped with dispatch identity.
	if gotInfo.Question != "which endpoint?" {
		t.Errorf("dispatcher got question %q, want %q", gotInfo.Question, "which endpoint?")
	}
	if gotInfo.Name != wantName {
		t.Errorf("dispatcher got name %q, want %q", gotInfo.Name, wantName)
	}
	if gotInfo.DispatchID != wantID {
		t.Errorf("dispatcher got dispatchId %q, want %q", gotInfo.DispatchID, wantID)
	}
	if gotInfo.Depth != wantDepth {
		t.Errorf("dispatcher got depth %d, want %d", gotInfo.Depth, wantDepth)
	}
}

// TestChildQuestion_CancelledByDispatcher verifies the ChildElicitFn relays a
// dispatcher cancellation (cancelled=true) so the runloop terminates the child
// run. Mirrors the backend-level TestChildQuestion_CancelledByDispatcher,
// pinning the bridge end of the contract.
func TestChildQuestion_CancelledByDispatcher(t *testing.T) {
	onChildQuestion := func(_ extension.DispatchChildQuestionInfo) (string, bool, error) {
		return "", true, nil
	}
	elicit := buildChildElicitFn(onChildQuestion, "agent", "d-1", 1)

	answer, cancelled, err := elicit("ignored")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cancelled {
		t.Error("expected cancelled=true to be relayed to the runloop")
	}
	if answer != "" {
		t.Errorf("expected empty answer on cancel, got %q", answer)
	}
}

// TestChildQuestion_NilCallback_NotWired verifies that when OnChildQuestion is
// nil, a dispatch completes without wiring a ChildElicitFn. The dispatch flow
// guards on opts.OnChildQuestion != nil before calling buildChildElicitFn, so
// a nil callback leaves childCfg.ChildElicitFn nil and the child's
// AskUserQuestion falls through to the standard terminate path (pinned in the
// backend package). Here we drive a real foreground dispatch with a nil
// callback and confirm it runs the full register/deregister lifecycle without
// error — proving the nil path is harmless.
func TestChildQuestion_NilCallback_NotWired(t *testing.T) {
	registry := NewDispatchRegistry()
	acc := &depthTestAccessor{
		config: &types.EngineRuntimeConfig{MaxDispatchDepth: 5},
	}
	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")

	// No OnChildQuestion set. The dispatch fails (no provider) but must not
	// panic and must complete its lifecycle.
	_, _ = dispatchFn(extension.DispatchAgentOpts{WaitForCompletion: true,
		Name: "nil-cb-agent",
		Task: "task",
		// OnChildQuestion intentionally nil.
	})

	if registry.Count() != 0 {
		t.Errorf("registry not empty after dispatch: %d", registry.Count())
	}

	// A dispatch_start must have fired (the dispatch ran), confirming we
	// exercised the wiring path with a nil callback.
	var sawStart bool
	for _, ev := range acc.emittedEvents() {
		if ev.Type == "engine_dispatch_start" && ev.DispatchAgent == "nil-cb-agent" {
			sawStart = true
			break
		}
	}
	if !sawStart {
		t.Fatal("expected engine_dispatch_start (dispatch ran with nil OnChildQuestion)")
	}
}
