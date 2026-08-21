package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// background_task_registry_test.go pins the session-scoped outstanding set —
// specifically that it is SESSION-scoped and not run-scoped, which is the
// property the whole park/wake cycle depends on.

// The set accumulates across separate runs. This is the core property: a model
// may start a command in one turn, have that run end, start another command in
// the next run, and both must still be outstanding when the session finally
// parks. A run-scoped set would forget the first command.
func TestOutstandingBackgroundTasks_AccumulateAcrossRuns(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "bg-accumulate"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Run 1 registers task A.
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 20")
	// Simulate the run ending: nothing about run teardown should touch the set.
	mgr.mu.Lock()
	mgr.sessions[key].requestID = ""
	mgr.mu.Unlock()

	// Run 2 registers task B.
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "sleep 40")

	got := mgr.OutstandingBackgroundTaskIDs(key)
	if len(got) != 2 {
		t.Fatalf("outstanding = %v, want both tasks after two separate runs", got)
	}
	if got[0] != "bash-1" || got[1] != "bash-2" {
		t.Errorf("outstanding = %v, want [bash-1 bash-2] in start order", got)
	}
}

// Draining removes exactly one task and reports the remainder, which is what
// the wake payload uses to tell the model what is still running.
func TestOutstandingBackgroundTasks_DrainReturnsRemainder(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "bg-drain"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "one")
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "two")
	mgr.registerOutstandingBackgroundTask(key, "bash-3", "three")

	mgr.mu.Lock()
	remaining, found := drainOutstandingBackgroundTaskLocked(mgr.sessions[key], "bash-2")
	mgr.mu.Unlock()

	if !found {
		t.Fatal("expected bash-2 to be found in the outstanding set")
	}
	if len(remaining) != 2 {
		t.Fatalf("remaining = %v, want 2 tasks", remaining)
	}
	if remaining[0].TaskID != "bash-1" || remaining[1].TaskID != "bash-3" {
		t.Errorf("remaining = %v, want [bash-1 bash-3]", remaining)
	}
	if remaining[0].Command != "one" {
		t.Errorf("remaining command = %q, want the command retained at registration", remaining[0].Command)
	}
}

// Draining a task that was never tracked reports found=false, so a completion
// for an untracked command emits its event but does not drive park/wake.
func TestOutstandingBackgroundTasks_DrainUntrackedReportsNotFound(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "bg-untracked"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "one")

	mgr.mu.Lock()
	remaining, found := drainOutstandingBackgroundTaskLocked(mgr.sessions[key], "bash-999")
	mgr.mu.Unlock()

	if found {
		t.Error("expected found=false for a task that was never registered")
	}
	if len(remaining) != 1 {
		t.Errorf("remaining = %v, want the tracked task untouched", remaining)
	}
}

// Session teardown clears the bookkeeping so a late completion finds nothing
// to revive.
func TestOutstandingBackgroundTasks_ClearedOnStop(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "bg-clear"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "one")
	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 1 {
		t.Fatalf("precondition failed: outstanding = %v", got)
	}

	mgr.clearOutstandingBackgroundTasks(key)

	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 0 {
		t.Errorf("outstanding = %v, want empty after clear", got)
	}
}

// The cap bounds the set: past it a command still runs and still notifies, it
// is simply not tracked, so a runaway loop cannot park the session on an
// unbounded pile.
func TestOutstandingBackgroundTasks_RespectsCap(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "bg-cap"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.config = &types.EngineRuntimeConfig{
		BackgroundTasks: &types.BackgroundTasksConfig{MaxOutstandingPerSession: 2},
	}

	mgr.registerOutstandingBackgroundTask(key, "bash-1", "one")
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "two")
	mgr.registerOutstandingBackgroundTask(key, "bash-3", "over the cap")

	got := mgr.OutstandingBackgroundTaskIDs(key)
	if len(got) != 2 {
		t.Errorf("outstanding = %v, want the set capped at 2", got)
	}
}

// The outstanding count reaches consumers on the existing status event rather
// than through a new event type, mirroring BackgroundAgents.
func TestOutstandingBackgroundTasks_RideStatusFields(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "bg-status"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "one")
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "two")

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	if fields.BackgroundShells != 2 {
		t.Errorf("StatusFields.BackgroundShells = %d, want 2", fields.BackgroundShells)
	}
	if !fields.HasPendingWork {
		t.Error("StatusFields.HasPendingWork = false, want true while notifying shells remain")
	}
}

// An unknown session is a no-op, not a panic — a completion can arrive after
// teardown.
func TestOutstandingBackgroundTasks_UnknownSessionIsSafe(t *testing.T) {
	mgr := NewManager(newMockBackend())
	mgr.registerOutstandingBackgroundTask("no-such-session", "bash-1", "one")
	if got := mgr.OutstandingBackgroundTaskIDs("no-such-session"); got != nil {
		t.Errorf("outstanding for unknown session = %v, want nil", got)
	}
	mgr.clearOutstandingBackgroundTasks("no-such-session")
}
