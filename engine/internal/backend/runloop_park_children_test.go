package backend

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for the park-on-children turn-boundary decision (dispatch-lifecycle
// root cause A) and the suspend exit contract that runChild depends on.
//
// Revert bars:
//   - TestParkOnChildren_ParksInsteadOfCompleting fails if the child-dispatch
//     park check is removed from dispatchStopReason (the run completes and
//     TaskCompleteEvent fires).
//   - TestParkOnChildren_EmptySetCompletesAsToday fails if the park check
//     fires on an empty set (no TaskCompleteEvent would arrive).
//   - TestDrainSuspend_EmitsExitWithSuspendedSignal fails if the suspend
//     drain stops emitting the run exit (OnExit never fires and runChild
//     would deadlock — the pre-fix wiring).

// collectParkTestEvents wires an ApiBackend with channels observing
// TaskSuspendEvent, TaskCompleteEvent, and OnExit.
func collectParkTestEvents(b *ApiBackend) (suspendCh chan *types.TaskSuspendEvent, completeCh chan *types.TaskCompleteEvent, exitCh chan string) {
	suspendCh = make(chan *types.TaskSuspendEvent, 4)
	completeCh = make(chan *types.TaskCompleteEvent, 4)
	exitCh = make(chan string, 4)
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		switch e := ev.Data.(type) {
		case *types.TaskSuspendEvent:
			suspendCh <- e
		case *types.TaskCompleteEvent:
			completeCh <- e
		}
	})
	b.OnExit(func(_ string, _ *int, signal *string, _ string) {
		sig := ""
		if signal != nil {
			sig = *signal
		}
		exitCh <- sig
	})
	return suspendCh, completeCh, exitCh
}

func TestParkOnChildren_ParksInsteadOfCompleting(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{textResponse("lead finished its turn", 10, 5)})
	b := NewApiBackend()
	suspendCh, completeCh, exitCh := collectParkTestEvents(b)

	cfg := &RunConfig{
		OutstandingChildDispatches: func() []string {
			return []string{"dispatch-specialist-123"}
		},
	}
	b.StartRunWithConfig("park-run", types.RunOptions{
		Prompt: "go", Model: testModel, EarlyStopEnabled: testEarlyStopDisabled(),
	}, cfg)

	// The suspend-shaped park must emit TaskSuspendEvent with the dispatch IDs...
	select {
	case ts := <-suspendCh:
		if len(ts.AwaitingDispatchIDs) != 1 || ts.AwaitingDispatchIDs[0] != "dispatch-specialist-123" {
			t.Errorf("AwaitingDispatchIDs = %v, want [dispatch-specialist-123]", ts.AwaitingDispatchIDs)
		}
		if len(ts.AwaitingTaskIDs) != 0 {
			t.Errorf("AwaitingTaskIDs = %v, want empty (child park, not bash park)", ts.AwaitingTaskIDs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no TaskSuspendEvent — the run did not park on its outstanding child dispatches")
	}

	// ...and the run's exit with the "suspended" signal (what releases
	// runChild's childDone so it can observe the park).
	select {
	case sig := <-exitCh:
		if sig != "suspended" {
			t.Errorf("exit signal = %q, want \"suspended\"", sig)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no exit after park — runChild would deadlock on childDone")
	}

	// And NO completion: the work is not done, it is merely not occupying a turn.
	select {
	case <-completeCh:
		t.Fatal("TaskCompleteEvent fired for a parked run — the park must suppress completion")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestParkOnChildren_EmptySetCompletesAsToday(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{textResponse("all done", 10, 5)})
	b := NewApiBackend()
	suspendCh, completeCh, _ := collectParkTestEvents(b)

	cfg := &RunConfig{
		OutstandingChildDispatches: func() []string { return nil },
	}
	b.StartRunWithConfig("park-run-empty", types.RunOptions{
		Prompt: "go", Model: testModel, EarlyStopEnabled: testEarlyStopDisabled(),
	}, cfg)

	select {
	case <-completeCh:
		// Expected: an empty outstanding set falls through to normal completion.
	case <-time.After(5 * time.Second):
		t.Fatal("no TaskCompleteEvent — empty child set must complete exactly as before")
	}
	select {
	case <-suspendCh:
		t.Fatal("TaskSuspendEvent fired with an empty outstanding set")
	default:
	}
}

func TestParkOnChildren_NilSeamCompletesAsToday(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{textResponse("root session", 10, 5)})
	b := NewApiBackend()
	_, completeCh, _ := collectParkTestEvents(b)

	// nil cfg — the pre-existing consumer shape (root sessions, tests).
	b.StartRunWithConfig("park-run-nil", types.RunOptions{
		Prompt: "go", Model: testModel, EarlyStopEnabled: testEarlyStopDisabled(),
	}, nil)

	select {
	case <-completeCh:
	case <-time.After(5 * time.Second):
		t.Fatal("no TaskCompleteEvent — nil RunConfig must be unaffected by the child park")
	}
}

// TestDrainSuspend_EmitsExitWithSuspendedSignal pins the suspend exit
// contract: a run that drains an extension-driven suspend signal emits
// TaskSuspendEvent AND its exit (signal "suspended"). The exit is what
// releases the dispatch goroutine's childDone WaitGroup; without it the
// suspend feature deadlocks (the pre-fix wiring omitted it).
func TestDrainSuspend_EmitsExitWithSuspendedSignal(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{textResponse("turn text", 10, 5)})
	b := NewApiBackend()
	suspendCh, completeCh, exitCh := collectParkTestEvents(b)

	b.StartRunWithConfig("suspend-exit-run", types.RunOptions{
		Prompt: "go", Model: testModel, EarlyStopEnabled: testEarlyStopDisabled(),
	}, nil)
	if !b.SignalSuspend("suspend-exit-run", []string{"child-a"}) {
		t.Fatal("SignalSuspend not delivered")
	}

	select {
	case ts := <-suspendCh:
		if len(ts.AwaitingDispatchIDs) != 1 || ts.AwaitingDispatchIDs[0] != "child-a" {
			t.Errorf("AwaitingDispatchIDs = %v, want [child-a]", ts.AwaitingDispatchIDs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no TaskSuspendEvent from drained suspend")
	}
	select {
	case sig := <-exitCh:
		if sig != "suspended" {
			t.Errorf("exit signal = %q, want \"suspended\"", sig)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no exit after suspend drain — runChild deadlocks on childDone")
	}
	select {
	case <-completeCh:
		t.Fatal("TaskCompleteEvent fired for a suspended run")
	case <-time.After(300 * time.Millisecond):
	}
}
