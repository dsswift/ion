//go:build !windows

// Detached-background-command status coverage. Uses a real POSIX background
// command (the tools package's own idiom, see bash_background_test.go), so
// Windows CI is excluded.

package session

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// REPORTED DEFECT: a `Bash({ run_in_background: true })` command started
// WITHOUT `notify_on_complete` ran for 96 seconds while every consumer surface
// except the transcript's Bash operation group reported the conversation
// finished.
//
// The engine side of that defect had two parts, both pinned here:
//
//  1. `BackgroundShells` and `HasPendingWork` count only the NOTIFYING set
//     (the commands the engine parks the session on). That is correct and
//     deliberate — but it means `ActiveBackgroundTasks` is the ONLY field that
//     reports a detached process, so it must always be populated.
//
//  2. `engine_status` is a COMPLETE snapshot by contract: consumers replace
//     their StatusFields with the payload. Several emission sites built
//     StatusFields by hand and omitted `ActiveBackgroundTasks` entirely, so the
//     next status event after a detached command started erased it from every
//     consumer's view even though the process was still running.

// startDetachedCommand launches a real long-running background command owned by
// key, with notify_on_complete deliberately FALSE, and returns its task ID.
func startDetachedCommand(t *testing.T, key string) string {
	t.Helper()

	ctx := tools.WithBackgroundTaskOwner(context.Background(), key)
	bash := tools.GetTool("Bash")
	if bash == nil {
		t.Fatal("Bash tool is not registered")
	}
	result, err := bash.Execute(ctx, map[string]any{
		"command":           "sleep 30",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("Bash run_in_background: %v", err)
	}
	if result.IsError {
		t.Fatalf("Bash run_in_background returned an error result: %s", result.Content)
	}
	if result.BackgroundTaskID == "" {
		t.Fatalf("Bash returned no BackgroundTaskID; content=%s", result.Content)
	}

	t.Cleanup(func() { tools.StopBackgroundTasksForOwner(key) })

	// The registry row is written before the tool returns, so the task is
	// already visible; assert that rather than sleeping on it.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(tools.BackgroundTasksForOwner(key)) > 0 {
			return result.BackgroundTaskID
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("background task %s never appeared in the registry for owner %s", result.BackgroundTaskID, key)
	return ""
}

func TestBuildStatusFields_ReportsDetachedBackgroundCommand(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "status-detached-bash"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	taskID := startDetachedCommand(t, key)

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}

	// The notify-only counters are CORRECTLY zero: nothing is waiting on a
	// detached command, and the engine did not park the session. Pinning this
	// keeps a future "fix" from inflating them, which would make the engine
	// claim it is holding a session open when it is not.
	if fields.BackgroundShells != 0 {
		t.Errorf("BackgroundShells = %d, want 0 for a detached command", fields.BackgroundShells)
	}
	if fields.HasPendingWork {
		t.Error("HasPendingWork = true, want false: the engine parks on notifying commands only")
	}

	// ActiveBackgroundTasks is therefore the ONLY signal a consumer has, so it
	// must carry the live process.
	if len(fields.ActiveBackgroundTasks) != 1 {
		t.Fatalf("ActiveBackgroundTasks = %d entries, want 1 (the live detached command)", len(fields.ActiveBackgroundTasks))
	}
	task := fields.ActiveBackgroundTasks[0]
	if task.TaskID != taskID {
		t.Errorf("ActiveBackgroundTasks[0].TaskID = %q, want %q", task.TaskID, taskID)
	}
	if task.NotifyOnComplete {
		t.Error("ActiveBackgroundTasks[0].NotifyOnComplete = true, want false")
	}
	if task.Command == "" {
		t.Error("ActiveBackgroundTasks[0].Command is empty; a consumer cannot describe the process")
	}

	// The engine_session_status mirror must carry it too — a consumer reading
	// only the typed event has no other source.
	mgr.mu.RLock()
	s := mgr.sessions[key]
	mgr.mu.RUnlock()
	mirror := buildSessionStatusMirror(key, fields, s)
	if mirror.SessionStatus == nil {
		t.Fatal("buildSessionStatusMirror produced no SessionStatus")
	}
	if len(mirror.SessionStatus.ActiveBackgroundTasks) != 1 {
		t.Fatalf("mirror ActiveBackgroundTasks = %d entries, want 1", len(mirror.SessionStatus.ActiveBackgroundTasks))
	}
}

// A status snapshot built by hand at an emission site must carry the live
// inventory, because engine_status is a complete-replacement snapshot. This is
// the second half of the reported defect: the run-start, extension-restart,
// idle-after-host-death, and clear emissions each constructed StatusFields
// directly, so any one of them erased a live detached command from every
// consumer between the command's start and its terminal event.
func TestLiveBackgroundTaskStates_SurvivesHandBuiltSnapshots(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "status-detached-handbuilt"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	taskID := startDetachedCommand(t, key)

	states := liveBackgroundTaskStates(key)
	if len(states) != 1 || states[0].TaskID != taskID {
		t.Fatalf("liveBackgroundTaskStates(%q) = %+v, want the one live task %q", key, states, taskID)
	}

	// A hand-built snapshot that omits the field publishes an empty inventory,
	// which is what erased the command. Assert the shape every such site now
	// uses.
	handBuilt := &types.StatusFields{
		Label:                 key,
		State:                 "running",
		ActiveBackgroundTasks: liveBackgroundTaskStates(key),
	}
	if len(handBuilt.ActiveBackgroundTasks) != 1 {
		t.Fatalf("hand-built snapshot carried %d tasks, want 1", len(handBuilt.ActiveBackgroundTasks))
	}

	// An unrelated session must not see another session's processes.
	if other := liveBackgroundTaskStates("some-other-session"); len(other) != 0 {
		t.Errorf("liveBackgroundTaskStates leaked %d tasks to an unrelated owner", len(other))
	}
}

func TestLiveBackgroundTaskStates_EmptyWhenNothingRuns(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "status-no-bash"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if states := liveBackgroundTaskStates(key); states != nil {
		t.Errorf("liveBackgroundTaskStates = %+v, want nil so the field is omitted from the wire", states)
	}

	fields, ok := mgr.buildStatusFields(key)
	if !ok {
		t.Fatal("buildStatusFields returned no session")
	}
	if len(fields.ActiveBackgroundTasks) != 0 {
		t.Errorf("ActiveBackgroundTasks = %d entries, want 0 for an idle session", len(fields.ActiveBackgroundTasks))
	}
}
