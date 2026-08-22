package extcontext

import (
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for the background-bash half of the parked-dispatch revive machinery.
//
// The defect these pin (conversation 1786766759781-04f06e87ca46): a dispatched
// agent started background commands, suspended, and parked on PendingTasks.
// The completions arrived at the session layer, which removed the task ids
// from the dispatch's wait set and then delivered the results to the ROOT run.
// Nothing ever signalled the parked dispatch's ReviveCh, and its revive select
// had only two exits (revive, recall) — so the dispatch, and both ancestors
// parked on it, stayed wedged permanently with every tree record still
// `running`.

// TestDeliverTaskResult_RevivesTaskOnlyPark pins the core fix: the last
// background command in a task-only wait set signals the parked dispatch and
// its result is available to the resume prompt.
//
// Revert-red: restore the old NotifyTaskComplete (delete from PendingTasks, no
// ReviveCh signal) and the reviveCh assertion fails — which is exactly the
// eternal park observed in production.
func TestDeliverTaskResult_RevivesTaskOnlyPark(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-1", "shell-agent", func() {}, nil, "sess", "", 1)

	reviveCh := make(chan struct{}, 1)
	if !r.SetSuspendedStateWithWaitingOn("disp-1", reviveCh, nil, []string{"bash-1", "bash-2"}) {
		t.Fatal("SetSuspendedStateWithWaitingOn refused to park on tasks")
	}

	owner, revived := r.DeliverTaskResult("bash-1", TaskResultRecord{Status: "completed", Payload: "first done"})
	if owner != "disp-1" {
		t.Errorf("owner = %q, want disp-1 — the parked dispatch owns the task", owner)
	}
	if revived {
		t.Error("revived = true with one task still outstanding")
	}
	select {
	case <-reviveCh:
		t.Fatal("reviveCh signalled while a background command is still running")
	default:
	}

	owner, revived = r.DeliverTaskResult("bash-2", TaskResultRecord{Status: "failed", ExitCode: 2, Payload: "second done"})
	if owner != "disp-1" || !revived {
		t.Fatalf("DeliverTaskResult = (%q, %v), want (disp-1, true) on the last outstanding task", owner, revived)
	}
	select {
	case <-reviveCh:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("reviveCh not signalled after the last background command completed — the dispatch is parked forever")
	}

	drained := r.DrainTaskResults("disp-1")
	if len(drained) != 2 {
		t.Fatalf("DrainTaskResults returned %d records, want 2", len(drained))
	}
	if drained[0].Payload != "first done" || drained[1].ExitCode != 2 {
		t.Errorf("drained records = %+v, want both command outcomes with exit codes intact", drained)
	}
	if r.DrainTaskResults("disp-1") != nil {
		t.Error("DrainTaskResults returned records twice; the drain must consume them")
	}
}

// TestDeliverTaskResult_MixedWaitSetWaitsForBothHalves pins that neither half
// of a mixed park revives alone: a task completing while a child is pending
// does not signal, and a child completing while a task is pending does not
// either. Reviving early resumes the agent while its own shell command is
// still running, and leaves DeliverTaskResult with no armed channel to signal.
//
// Revert-red: remove the PendingTasks guard added to NotifyChildComplete and
// the child arm below signals.
func TestDeliverTaskResult_MixedWaitSetWaitsForBothHalves(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-2", "lead", func() {}, nil, "sess", "", 1)

	reviveCh := make(chan struct{}, 1)
	if !r.SetSuspendedStateWithWaitingOn("disp-2", reviveCh, []string{"child-1"}, []string{"bash-9"}) {
		t.Fatal("SetSuspendedStateWithWaitingOn refused to park on a mixed wait set")
	}

	if _, revived := r.DeliverTaskResult("bash-9", TaskResultRecord{Status: "completed"}); revived {
		t.Error("task completion revived a dispatch still awaiting a child")
	}
	select {
	case <-reviveCh:
		t.Fatal("reviveCh signalled with a child still pending")
	default:
	}

	if !r.NotifyChildComplete("disp-2", "child-1") {
		t.Fatal("NotifyChildComplete did not signal once both halves of the wait set were satisfied")
	}
	select {
	case <-reviveCh:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("reviveCh not signalled after the last awaited child completed")
	}
}

// TestDeliverTaskResult_ChildDoesNotReviveWhileTaskOutstanding is the mirror
// arm: the children draining first must not release a park that still has a
// background command outstanding.
func TestDeliverTaskResult_ChildDoesNotReviveWhileTaskOutstanding(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-3", "lead", func() {}, nil, "sess", "", 1)

	reviveCh := make(chan struct{}, 1)
	if !r.SetSuspendedStateWithWaitingOn("disp-3", reviveCh, []string{"child-1"}, []string{"bash-9"}) {
		t.Fatal("SetSuspendedStateWithWaitingOn refused to park on a mixed wait set")
	}

	if r.NotifyChildComplete("disp-3", "child-1") {
		t.Error("NotifyChildComplete signalled while a background command was still outstanding")
	}
	select {
	case <-reviveCh:
		t.Fatal("reviveCh signalled with a background command still running")
	default:
	}

	if _, revived := r.DeliverTaskResult("bash-9", TaskResultRecord{Status: "completed"}); !revived {
		t.Fatal("the last outstanding background command did not revive the dispatch")
	}
	select {
	case <-reviveCh:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("reviveCh not signalled after the wait set fully drained")
	}
}

// TestDeliverTaskResult_SettledBeforeArmingPrunesPark pins the arming race:
// a command that finishes between the run's park emission and the registry
// arming has no armed channel to signal and would never notify again. The
// completion is remembered and consumed by the prune, which refuses the park
// (caller revives immediately) and carries the result along.
//
// Revert-red: drop the settled-task prune from
// SetSuspendedStateWithWaitingOn and this parks on a dead task id.
func TestDeliverTaskResult_SettledBeforeArmingPrunesPark(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-4", "shell-agent", func() {}, nil, "sess", "", 1)

	owner, revived := r.DeliverTaskResult("bash-early", TaskResultRecord{Status: "completed", Payload: "raced the arming"})
	if owner != "" || revived {
		t.Fatalf("DeliverTaskResult = (%q, %v), want ('', false) when no dispatch awaits the task yet", owner, revived)
	}

	reviveCh := make(chan struct{}, 1)
	if r.SetSuspendedStateWithWaitingOn("disp-4", reviveCh, nil, []string{"bash-early"}) {
		t.Fatal("SetSuspendedStateWithWaitingOn parked on a task that had already completed")
	}

	drained := r.DrainTaskResults("disp-4")
	if len(drained) != 1 || drained[0].Payload != "raced the arming" {
		t.Fatalf("drained = %+v, want the settled completion carried onto the dispatch", drained)
	}
}

// TestReviveResumePrompt_CarriesTaskResults pins that a task-only revive
// injects the command outcome and the no-restart instruction, and is
// classified as a background-task completion rather than a child completion.
func TestReviveResumePrompt_CarriesTaskResults(t *testing.T) {
	tasks := []TaskResultRecord{{TaskID: "bash-7", Status: "failed", ExitCode: 2, Payload: "go build: syntax error"}}

	prompt := buildReviveResumePromptWith(nil, tasks)
	for _, want := range []string{"bash-7", "go build: syntax error", "do NOT restart"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("task-only revive prompt missing %q:\n%s", want, prompt)
		}
	}
	if got, want := reviveKindWithTasks(nil, tasks), string(types.InjectionKindBackgroundTaskCompletion); got != want {
		t.Errorf("injection kind = %q, want %q", got, want)
	}

	children := []ChildResultRecord{{ChildID: "child-1", Name: "worker", Output: "child output", ExitCode: 0}}
	both := buildReviveResumePromptWith(children, tasks)
	for _, want := range []string{"child output", "go build: syntax error"} {
		if !strings.Contains(both, want) {
			t.Errorf("mixed revive prompt missing %q:\n%s", want, both)
		}
	}
	if got, want := reviveKindWithTasks(children, tasks), string(types.InjectionKindAgentCompletion); got != want {
		t.Errorf("mixed injection kind = %q, want %q", got, want)
	}
}

// parkTimeoutAccessor overrides EngineConfig so a test can set a park ceiling
// short enough to observe. Everything else delegates to idTestAccessor.
type parkTimeoutAccessor struct {
	*idTestAccessor
	cfg *types.EngineRuntimeConfig
}

func (a *parkTimeoutAccessor) EngineConfig() *types.EngineRuntimeConfig { return a.cfg }

// TestDispatch_ParkTimeoutGoesTerminal pins the backstop: a dispatch whose
// awaited work never signals must reach a terminal error once the park ceiling
// elapses, not block on reviveCh forever. The terminal path is what records
// the result and fires NotifyChildComplete, so this is also what releases
// every ancestor parked on this dispatch.
//
// Revert-red: remove the parkTimer case from the revive select and this test
// times out — the exact shape of the production wedge.
func TestDispatch_ParkTimeoutGoesTerminal(t *testing.T) {
	registry := NewDispatchRegistry()
	child := newScriptedChildBackend(childRunScript{
		events: []types.NormalizedEvent{
			{Data: &types.SessionInitEvent{SessionID: "conv-parked"}},
			{Data: &types.TaskSuspendEvent{AwaitingTaskIDs: []string{"bash-lost"}}},
		},
		code: 0, signal: "suspended",
	})
	acc := &parkTimeoutAccessor{
		idTestAccessor: &idTestAccessor{child: child},
		cfg: &types.EngineRuntimeConfig{
			BackgroundTasks: &types.BackgroundTasksConfig{ParkTimeoutMs: 150},
		},
	}
	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")

	completeCh := make(chan extension.DispatchAgentResult, 1)
	errCh := make(chan extension.DispatchError, 1)
	if _, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "shell-agent",
		Task:       "park on a command that never notifies",
		Background: true,
		OnComplete: func(r extension.DispatchAgentResult) { completeCh <- r },
		OnError:    func(e extension.DispatchError) { errCh <- e },
	}); err != nil {
		t.Fatalf("dispatch error: %v", err)
	}

	select {
	case e := <-errCh:
		if e.ExitCode == 0 {
			t.Errorf("ExitCode = 0 on a timed-out park, want non-zero")
		}
		if !strings.Contains(e.Message, "park timed out") || !strings.Contains(e.Message, "bash-lost") {
			t.Errorf("error message %q must name the timeout and the awaited work", e.Message)
		}
	case r := <-completeCh:
		t.Fatalf("OnComplete fired for a timed-out park (output %q) — a lost wake is not a success", r.Output)
	case <-time.After(10 * time.Second):
		t.Fatal("the dispatch never left its park: no terminal callback after the park ceiling elapsed")
	}
}
