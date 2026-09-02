package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// A background command started inside a dispatched agent is owned by the ROOT
// session (task ownership is session-scoped), so its completion arrives at the
// session layer. If the session delivers it to the root, the dispatch that is
// parked on that command never learns it finished — the wedge observed in
// conversation 1786766759781-04f06e87ca46, where two grandchildren parked on
// finished shells and both ancestors stayed parked behind them.

// TestBackgroundWake_ParkedDispatchConsumesCompletion pins the routing: when a
// parked dispatch owns the task, the completion revives that dispatch and the
// root neither starts a run nor claims its park.
//
// Revert-red: restore the old call (remove the task id from the dispatch wait
// set without signalling, then fall through to the root paths) and both the
// "no run started" and "dispatch revived" assertions fail.
func TestBackgroundWake_ParkedDispatchConsumesCompletion(t *testing.T) {
	key := "wake-dispatch-owned"
	mgr, mb, _ := newWakeManager(t, key, types.BackgroundDeliveryWake)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "npm test")

	mgr.mu.Lock()
	s := mgr.sessions[key]
	registry := s.dispatchRegistry
	// The root also parked on the command, as it does when a dispatch's shell
	// is the only outstanding work.
	s.parked = &parkedRun{TaskIDs: []string{"bash-1"}, ParkedAt: time.Now()}
	mgr.mu.Unlock()
	if registry == nil {
		t.Fatal("session has no dispatch registry")
	}

	registry.RegisterWithID("disp-owner", "shell-agent", func() {}, nil, key, "", 1)
	reviveCh := make(chan struct{}, 1)
	if !registry.SetSuspendedStateWithWaitingOn("disp-owner", reviveCh, nil, []string{"bash-1"}, nil) {
		t.Fatal("dispatch refused to park on the task")
	}

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "npm test"))

	select {
	case <-reviveCh:
	case <-time.After(2 * time.Second):
		t.Fatal("the parked dispatch was never revived; its completion was delivered elsewhere")
	}
	if started := mb.startedInOrder(); len(started) != 0 {
		t.Errorf("root runs started = %v, want none — the dispatch owns this completion", started)
	}

	mgr.mu.Lock()
	stillParked := mgr.sessions[key].parked != nil
	mgr.mu.Unlock()
	if !stillParked {
		t.Error("root park was claimed by a completion the root never received")
	}

	drained := registry.DrainTaskResults("disp-owner")
	if len(drained) != 1 || drained[0].TaskID != "bash-1" {
		t.Fatalf("dispatch task results = %+v, want the bash-1 completion recorded for its resume prompt", drained)
	}
	if drained[0].Payload == "" {
		t.Error("recorded payload is empty; the revived dispatch would resume blind")
	}
}

// TestBackgroundWake_UnownedCompletionStillWakesRoot pins the fall-through: a
// command no dispatch is parked on behaves exactly as before — the root is
// woken with the result.
func TestBackgroundWake_UnownedCompletionStillWakesRoot(t *testing.T) {
	key := "wake-root-owned"
	mgr, mb, _ := newWakeManager(t, key, types.BackgroundDeliveryWake)
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "make build")

	mgr.mu.Lock()
	registry := mgr.sessions[key].dispatchRegistry
	mgr.mu.Unlock()
	// A parked dispatch exists, but it is waiting on a DIFFERENT command.
	registry.RegisterWithID("disp-other", "shell-agent", func() {}, nil, key, "", 1)
	if !registry.SetSuspendedStateWithWaitingOn("disp-other", registryReviveCh(), nil, []string{"bash-99"}, nil) {
		t.Fatal("dispatch refused to park")
	}

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-2", "make build"))

	if started := mb.startedInOrder(); len(started) != 1 {
		t.Fatalf("root runs started = %v, want exactly one wake", started)
	}
	if drained := registry.DrainTaskResults("disp-other"); len(drained) != 0 {
		t.Errorf("unrelated dispatch recorded %d results, want none", len(drained))
	}
}

// registryReviveCh returns a buffered revive channel for a park no test arm
// waits on.
func registryReviveCh() chan struct{} { return make(chan struct{}, 1) }
