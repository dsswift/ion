//go:build !windows

// Completion-notifier tests use POSIX shell commands (sleep, exit) and rely on
// real process termination; Windows CI has no bash.

package tools

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// notifierRecorder captures TaskCompletion callbacks for assertion.
type notifierRecorder struct {
	mu   sync.Mutex
	got  []TaskCompletion
	fire chan struct{}
}

func newNotifierRecorder() *notifierRecorder {
	return &notifierRecorder{fire: make(chan struct{}, 16)}
}

func (r *notifierRecorder) notify(c TaskCompletion) {
	r.mu.Lock()
	r.got = append(r.got, c)
	r.mu.Unlock()
	select {
	case r.fire <- struct{}{}:
	default:
	}
}

func (r *notifierRecorder) all() []TaskCompletion {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]TaskCompletion, len(r.got))
	copy(out, r.got)
	return out
}

// waitForNotification blocks until at least n notifications have arrived.
func (r *notifierRecorder) waitFor(t *testing.T, n int, timeout time.Duration) []TaskCompletion {
	t.Helper()
	deadline := time.After(timeout)
	for {
		if got := r.all(); len(got) >= n {
			return got
		}
		select {
		case <-r.fire:
		case <-deadline:
			t.Fatalf("expected %d completion notification(s) within %s, got %d", n, timeout, len(r.all()))
		}
	}
}

// installRecorder wires a recorder as the process-wide notifier and restores
// the previous value afterwards.
func installRecorder(t *testing.T) *notifierRecorder {
	t.Helper()
	rec := newNotifierRecorder()
	SetTaskCompletionNotifier(rec.notify)
	t.Cleanup(func() { SetTaskCompletionNotifier(nil) })
	return rec
}

// startNotifyingTask runs a background command with notify_on_complete via the
// real Bash tool path, so the test exercises the same wiring production uses.
func startNotifyingTask(t *testing.T, command string) string {
	t.Helper()
	ctx := WithBackgroundTaskOwner(context.Background(), "sess-notify")
	res, err := executeBash(ctx, map[string]any{
		"command":            command,
		"run_in_background":  true,
		"notify_on_complete": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("executeBash returned error: %v", err)
	}
	if res.IsError {
		t.Fatalf("executeBash reported tool error: %s", res.Content)
	}
	return extractTaskID(t, res.Content)
}

func TestBackgroundNotifier_ResultDirectsIdleWaitToPark(t *testing.T) {
	clearBashTasks(t)
	rec := installRecorder(t)

	ctx := WithBackgroundTaskOwner(context.Background(), "sess-result-guidance")
	ctx = WithOutstandingRegistrar(ctx, func(_, _ string) {})
	res, err := executeBash(ctx, map[string]any{
		"command":            "echo guided",
		"run_in_background":  true,
		"notify_on_complete": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("executeBash returned error: %v", err)
	}
	if res.IsError {
		t.Fatalf("executeBash reported tool error: %s", res.Content)
	}
	for _, want := range []string{"only remaining work", "end your turn", "parks the session", "resumes it"} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("background result missing %q; got %q", want, res.Content)
		}
	}
	rec.waitFor(t, 1, 5*time.Second)
}

// A clean exit notifies with status "completed" and exit code 0.
func TestBackgroundNotifier_CleanExit(t *testing.T) {
	clearBashTasks(t)
	rec := installRecorder(t)

	taskID := startNotifyingTask(t, "echo done")

	got := rec.waitFor(t, 1, 5*time.Second)
	c := got[0]
	if c.TaskID != taskID {
		t.Errorf("TaskID = %q, want %q", c.TaskID, taskID)
	}
	if c.Status != "completed" {
		t.Errorf("Status = %q, want %q", c.Status, "completed")
	}
	if c.ExitCode != 0 {
		t.Errorf("ExitCode = %d, want 0", c.ExitCode)
	}
	if c.Owner != "sess-notify" {
		t.Errorf("Owner = %q, want %q", c.Owner, "sess-notify")
	}
	if c.OutputPath == "" {
		t.Error("OutputPath should name the on-disk output file")
	}
}

// A non-zero exit notifies with status "failed" and carries the exit code, so
// a woken orchestrator can tell success from failure without reading the file.
func TestBackgroundNotifier_NonZeroExit(t *testing.T) {
	clearBashTasks(t)
	rec := installRecorder(t)

	startNotifyingTask(t, "exit 3")

	c := rec.waitFor(t, 1, 5*time.Second)[0]
	if c.Status != "failed" {
		t.Errorf("Status = %q, want %q", c.Status, "failed")
	}
	if c.ExitCode != 3 {
		t.Errorf("ExitCode = %d, want 3", c.ExitCode)
	}
}

// TaskStop on a notifying task must still notify — with status "stopped".
// Without this a parked session waits forever on a task the model killed.
func TestBackgroundNotifier_StoppedViaTaskStop(t *testing.T) {
	clearBashTasks(t)
	rec := installRecorder(t)

	taskID := startNotifyingTask(t, `sh -c "sleep 30"`)

	res, err := executeTaskStop(context.Background(), map[string]any{"taskId": taskID}, "")
	if err != nil {
		t.Fatalf("executeTaskStop returned error: %v", err)
	}
	if res.IsError {
		t.Fatalf("executeTaskStop reported tool error: %s", res.Content)
	}

	c := rec.waitFor(t, 1, 5*time.Second)[0]
	if c.TaskID != taskID {
		t.Errorf("TaskID = %q, want %q", c.TaskID, taskID)
	}
	if c.Status != "stopped" {
		t.Errorf("Status = %q, want %q", c.Status, "stopped")
	}
}

// Session teardown kills the session's background tasks; a notifying task must
// report "stopped" rather than vanishing silently.
func TestBackgroundNotifier_StoppedViaOwnerCleanup(t *testing.T) {
	clearBashTasks(t)
	rec := installRecorder(t)

	taskID := startNotifyingTask(t, `sh -c "sleep 30"`)
	StopBackgroundTasksForOwner("sess-notify")

	c := rec.waitFor(t, 1, 5*time.Second)[0]
	if c.TaskID != taskID {
		t.Errorf("TaskID = %q, want %q", c.TaskID, taskID)
	}
	if c.Status != "stopped" {
		t.Errorf("Status = %q, want %q", c.Status, "stopped")
	}
}

// Exactly one notification per task: the stop path and the Done-watcher must
// not both fire. A double notification would wake a parked session twice for
// one command.
func TestBackgroundNotifier_StopNotifiesExactlyOnce(t *testing.T) {
	clearBashTasks(t)
	rec := installRecorder(t)

	taskID := startNotifyingTask(t, `sh -c "sleep 30"`)
	StopBackgroundTasksForOwner("sess-notify")
	rec.waitFor(t, 1, 5*time.Second)

	// Give the Done-watcher time to observe the killed process and (wrongly)
	// send a second notification if the guard regressed.
	time.Sleep(500 * time.Millisecond)

	got := rec.all()
	count := 0
	for _, c := range got {
		if c.TaskID == taskID {
			count++
		}
	}
	if count != 1 {
		t.Errorf("notifications for %s = %d, want exactly 1 (got %+v)", taskID, count, got)
	}
}

// A task started WITHOUT notify_on_complete never notifies. This is the
// no-regression pin: existing background usage is untouched.
func TestBackgroundNotifier_NotRequestedDoesNotNotify(t *testing.T) {
	clearBashTasks(t)
	rec := installRecorder(t)

	ctx := WithBackgroundTaskOwner(context.Background(), "sess-quiet")
	res, err := executeBash(ctx, map[string]any{
		"command":           "echo quiet",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("executeBash returned error: %v", err)
	}
	taskID := extractTaskID(t, res.Content)
	waitForTaskStatus(t, taskID, "completed", 5*time.Second)

	if got := rec.all(); len(got) != 0 {
		t.Errorf("expected no notifications for a non-notifying task, got %+v", got)
	}
}

// With no notifier installed the task still runs and reaches a terminal state.
// The completion is logged and dropped; nothing panics.
func TestBackgroundNotifier_NoNotifierInstalled(t *testing.T) {
	clearBashTasks(t)
	SetTaskCompletionNotifier(nil)

	taskID := startNotifyingTask(t, "echo orphan")
	task := waitForTaskStatus(t, taskID, "completed", 5*time.Second)
	if task.ExitCode != 0 {
		t.Errorf("ExitCode = %d, want 0", task.ExitCode)
	}
}

// notify_on_complete with no owning session degrades to a plain background
// task: the completion would have nowhere to go, so the tool says so rather
// than promising a delivery that never arrives.
func TestBackgroundNotifier_NoOwnerDegradesToPlainTask(t *testing.T) {
	clearBashTasks(t)
	rec := installRecorder(t)

	res, err := executeBash(context.Background(), map[string]any{
		"command":            "echo ownerless",
		"run_in_background":  true,
		"notify_on_complete": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("executeBash returned error: %v", err)
	}
	taskID := extractTaskID(t, res.Content)
	waitForTaskStatus(t, taskID, "completed", 5*time.Second)

	if got := rec.all(); len(got) != 0 {
		t.Errorf("expected no notification without an owning session, got %+v", got)
	}
}

// The outstanding registrar is invoked for a notifying task so the session can
// hold for it, and is NOT invoked for a plain background task.
func TestBackgroundNotifier_RegistersWithOutstandingSet(t *testing.T) {
	clearBashTasks(t)
	installRecorder(t)

	var mu sync.Mutex
	var registered []string
	ctx := WithBackgroundTaskOwner(context.Background(), "sess-reg")
	ctx = WithOutstandingRegistrar(ctx, func(taskID, command string) {
		mu.Lock()
		registered = append(registered, taskID)
		mu.Unlock()
	})

	res, err := executeBash(ctx, map[string]any{
		"command":            "echo tracked",
		"run_in_background":  true,
		"notify_on_complete": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("executeBash returned error: %v", err)
	}
	notifyingID := extractTaskID(t, res.Content)

	plain, err := executeBash(ctx, map[string]any{
		"command":           "echo untracked",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("executeBash returned error: %v", err)
	}
	plainID := extractTaskID(t, plain.Content)

	mu.Lock()
	defer mu.Unlock()
	if len(registered) != 1 || registered[0] != notifyingID {
		t.Errorf("registered = %v, want exactly [%s]", registered, notifyingID)
	}
	for _, id := range registered {
		if id == plainID {
			t.Errorf("plain background task %s must not join the outstanding set", plainID)
		}
	}
}

// notify_on_complete is a free wait; Poll costs one inference per attempt. The
// observed misuse was a conversation that started a background command WITHOUT
// notify_on_complete and then paid a frontier model to poll its output file, so
// the Bash guidance must name the cheap path and warn Poll off this job.
func TestBashDescriptionSteersWaitingToNotifyOnComplete(t *testing.T) {
	def := BashTool()
	if !strings.Contains(def.Description, "never to watch a command you started here") {
		t.Errorf("Bash description does not warn Poll off background bash waiting: %s", def.Description)
	}
	props, _ := def.InputSchema["properties"].(map[string]any)

	background, _ := props["run_in_background"].(map[string]any)
	backgroundDesc, _ := background["description"].(string)
	if !strings.Contains(backgroundDesc, "notify_on_complete") {
		t.Errorf("run_in_background does not point at notify_on_complete: %q", backgroundDesc)
	}

	notify, _ := props["notify_on_complete"].(map[string]any)
	notifyDesc, _ := notify["description"].(string)
	if !strings.Contains(notifyDesc, "costs no inference") {
		t.Errorf("notify_on_complete does not state its cost advantage over Poll: %q", notifyDesc)
	}
}
