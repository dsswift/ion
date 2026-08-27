package session

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// background_task_wake_test.go pins the delivery matrix: what happens to a
// background command's completion depending on session state and configured
// delivery mode.

// completionFor builds a TaskCompletion as the tools layer would report one.
func testCompletion(owner, taskID, command string) tools.TaskCompletion {
	return tools.TaskCompletion{
		TaskID:     taskID,
		Owner:      owner,
		Command:    command,
		Status:     "completed",
		ExitCode:   0,
		ElapsedMs:  1234,
		OutputPath: "/tmp/" + taskID + ".out",
		Tail:       "output tail",
	}
}

func newWakeManager(t *testing.T, key string, delivery string) (*Manager, *mockBackend, *eventCollector) {
	t.Helper()
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if delivery != "" {
		mgr.config = &types.EngineRuntimeConfig{
			BackgroundTasks: &types.BackgroundTasksConfig{Delivery: delivery},
		}
	}
	return mgr, mb, ec
}

// The typed event fires for every completion, regardless of delivery mode.
// This is the engine's complete signaling obligation.
func TestBackgroundWake_EmitsTypedEventAlways(t *testing.T) {
	for _, mode := range []string{
		types.BackgroundDeliveryWake,
		types.BackgroundDeliveryQueue,
		types.BackgroundDeliveryEventOnly,
	} {
		t.Run(mode, func(t *testing.T) {
			key := "wake-event-" + mode
			mgr, _, ec := newWakeManager(t, key, mode)
			mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 1")

			mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "sleep 1"))

			evs := ec.byType("engine_background_task_complete")
			if len(evs) != 1 {
				t.Fatalf("expected exactly 1 typed completion event under %q, got %d", mode, len(evs))
			}
			payload := evs[0].event.BackgroundTaskComplete
			if payload == nil {
				t.Fatal("event carries no BackgroundTaskComplete payload")
			}
			if payload.TaskID != "bash-1" || payload.Status != "completed" || payload.ExitCode != 0 {
				t.Errorf("payload = %+v, want the completion's task id / status / exit code", payload)
			}
			if payload.Command != "sleep 1" {
				t.Errorf("payload.Command = %q, want the command carried through", payload.Command)
			}
		})
	}
}

func TestBackgroundTaskLifecycle_PreservesNonNotifyingStart(t *testing.T) {
	const key = "lifecycle-non-notifying"
	_, _, ec := newWakeManager(t, key, types.BackgroundDeliveryWake)
	t.Cleanup(func() { tools.StopBackgroundTasksForOwner(key) })
	ctx := tools.WithBackgroundTaskOwner(context.Background(), key)

	if _, err := tools.ExecuteTool(ctx, "Bash", map[string]any{
		"command":            `sh -c "sleep 60"`,
		"run_in_background":  true,
		"notify_on_complete": false,
	}, t.TempDir()); err != nil {
		t.Fatalf("start non-notifying background task: %v", err)
	}

	events := ec.byType("engine_background_task_started")
	if len(events) != 1 {
		t.Fatalf("start lifecycle events = %d, want 1", len(events))
	}
	payload := events[0].event.BackgroundTaskStarted
	if payload == nil {
		t.Fatal("start lifecycle event has no payload")
	}
	if payload.StartedAt == 0 {
		t.Error("startedAt = 0, want the task registry timestamp")
	}
	if payload.NotifyOnComplete {
		t.Error("notifyOnComplete = true, want false for a detached task")
	}
}

// Wake mode on an idle session starts a run whose prompt carries the result.
func TestBackgroundWake_WakeModeStartsRun(t *testing.T) {
	key := "wake-idle"
	mgr, mb, ec := newWakeManager(t, key, types.BackgroundDeliveryWake)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "make build")

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "make build"))

	keys := mb.startedInOrder()
	if len(keys) != 1 {
		t.Fatalf("expected exactly 1 run started on wake, got %d", len(keys))
	}
	opts, _ := mb.getStarted(keys[0])
	if !strings.Contains(opts.Prompt, "bash-1") {
		t.Errorf("wake prompt should name the completed task, got %q", opts.Prompt)
	}
	if !strings.Contains(opts.Prompt, "make build") {
		t.Errorf("wake prompt should name the command, got %q", opts.Prompt)
	}

	injected := ec.byType("engine_prompt_injected")
	if len(injected) != 1 {
		t.Fatalf("expected the wake prompt to be surfaced as engine_prompt_injected, got %d", len(injected))
	}
	if got := injected[0].event.InjectedPromptKind; got != BackgroundTaskCompletionInjectionKind {
		t.Errorf("injection kind = %q, want %q", got, BackgroundTaskCompletionInjectionKind)
	}
}

// event_only mode fires the signal and starts nothing. This is the operator's
// off switch for unattended runs.
func TestBackgroundWake_EventOnlyStartsNoRun(t *testing.T) {
	key := "wake-eventonly"
	mgr, mb, ec := newWakeManager(t, key, types.BackgroundDeliveryEventOnly)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 1")

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "sleep 1"))

	if keys := mb.startedInOrder(); len(keys) != 0 {
		t.Errorf("event_only must not start a run, got %d", len(keys))
	}
	if evs := ec.byType("engine_background_task_complete"); len(evs) != 1 {
		t.Errorf("event_only must still emit the typed event, got %d", len(evs))
	}
}

// queue mode holds the completion and delivers it with the next run.
func TestBackgroundWake_QueueModeDeliversOnNextRun(t *testing.T) {
	key := "wake-queue"
	mgr, mb, _ := newWakeManager(t, key, types.BackgroundDeliveryQueue)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 1")

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "sleep 1"))

	if keys := mb.startedInOrder(); len(keys) != 0 {
		t.Fatalf("queue mode must not start a run on completion, got %d", len(keys))
	}

	pending := mgr.takePendingBackgroundCompletions(key)
	if len(pending) != 1 {
		t.Fatalf("expected 1 queued completion, got %d", len(pending))
	}
	if !strings.Contains(pending[0].Text, "bash-1") {
		t.Errorf("queued payload should name the task, got %q", pending[0].Text)
	}
	// Drained exactly once.
	if again := mgr.takePendingBackgroundCompletions(key); len(again) != 0 {
		t.Errorf("queued completions should drain exactly once, got %d on the second take", len(again))
	}
}

// A completion arriving while a run is active is steered in mid-turn rather
// than starting a second run.
func TestBackgroundWake_ActiveRunStartsNoSecondRun(t *testing.T) {
	key := "wake-active"
	mgr, mb, _ := newWakeManager(t, key, types.BackgroundDeliveryWake)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 1")

	// Simulate an in-flight run.
	mgr.mu.Lock()
	mgr.sessions[key].requestID = "run-active"
	mgr.mu.Unlock()

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "sleep 1"))

	// The mock backend is not steerable, so the steer is not delivered and the
	// completion falls through to the wake path rather than being dropped —
	// what must NOT happen is the completion vanishing.
	if keys := mb.startedInOrder(); len(keys) > 1 {
		t.Errorf("expected at most one run from the fallthrough, got %d", len(keys))
	}
}

// A completion for a session that no longer exists is logged and dropped.
func TestBackgroundWake_UnknownSessionIsDropped(t *testing.T) {
	mgr := NewManager(newMockBackend())
	// Must not panic.
	mgr.onBackgroundTaskComplete(testCompletion("no-such-session", "bash-1", "sleep 1"))
}

// A completion with no owner has nowhere to go and is dropped.
func TestBackgroundWake_NoOwnerIsDropped(t *testing.T) {
	mgr := NewManager(newMockBackend())
	mgr.onBackgroundTaskComplete(testCompletion("", "bash-1", "sleep 1"))
}

// An untracked completion (started without joining the outstanding set) emits
// its event but does not drive delivery.
func TestBackgroundWake_UntrackedCompletionSignalsOnly(t *testing.T) {
	key := "wake-untracked"
	mgr, mb, ec := newWakeManager(t, key, types.BackgroundDeliveryWake)

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-untracked", "sleep 1"))

	if evs := ec.byType("engine_background_task_complete"); len(evs) != 1 {
		t.Errorf("expected the typed event even for an untracked task, got %d", len(evs))
	}
	if keys := mb.startedInOrder(); len(keys) != 0 {
		t.Errorf("an untracked completion must not wake the session, got %d runs", len(keys))
	}
}

// The wake payload names the remaining outstanding commands, which is what
// lets the model decide between parking again and doing unblocked work.
func TestBackgroundWake_PayloadListsRemainingWork(t *testing.T) {
	key := "wake-remaining"
	mgr, mb, ec := newWakeManager(t, key, types.BackgroundDeliveryWake)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "first")
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "second")
	mgr.registerOutstandingBackgroundTask(key, "bash-3", "third")

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "first"))

	keys := mb.startedInOrder()
	if len(keys) != 1 {
		t.Fatalf("expected 1 run, got %d", len(keys))
	}
	opts, _ := mb.getStarted(keys[0])
	for _, want := range []string{"bash-2", "bash-3", "second", "third"} {
		if !strings.Contains(opts.Prompt, want) {
			t.Errorf("wake prompt missing %q; got:\n%s", want, opts.Prompt)
		}
	}

	// The typed event carries the same remainder for consumers that render
	// progress without reading the prompt.
	payload := ec.byType("engine_background_task_complete")[0].event.BackgroundTaskComplete
	if len(payload.RemainingTaskIDs) != 2 {
		t.Errorf("RemainingTaskIDs = %v, want 2 entries", payload.RemainingTaskIDs)
	}
}

// Parking records state and arms the wake; a completion then clears it.
func TestBackgroundWake_ParkThenWakeClearsParkState(t *testing.T) {
	key := "wake-park"
	mgr, _, _ := newWakeManager(t, key, types.BackgroundDeliveryWake)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 1")

	mgr.markSessionParked(key, []string{"bash-1"})

	mgr.mu.RLock()
	parked := mgr.sessions[key].parked != nil
	mgr.mu.RUnlock()
	if !parked {
		t.Fatal("expected the session to be recorded as parked")
	}

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "sleep 1"))

	mgr.mu.RLock()
	stillParked := mgr.sessions[key].parked != nil
	mgr.mu.RUnlock()
	if stillParked {
		t.Error("expected the park to be cleared once a completion woke the session")
	}
}

// ParkMainLoop refuses to park a session with nothing outstanding — parking
// then would strand it until the timeout.
func TestBackgroundWake_ParkRefusedWithNothingOutstanding(t *testing.T) {
	key := "wake-park-refuse"
	mgr, _, _ := newWakeManager(t, key, types.BackgroundDeliveryWake)

	mgr.mu.Lock()
	mgr.sessions[key].requestID = "run-1"
	mgr.mu.Unlock()

	if mgr.ParkMainLoop(key) {
		t.Error("ParkMainLoop should refuse when no background commands are outstanding")
	}
}

// ParkMainLoop must resolve the park capability on a real HybridBackend.
// Before HybridBackend grew SignalParkForBackgroundTasks, the assertion in
// ParkMainLoop targeted the outer backend — which under backend: "hybrid" is
// the *HybridBackend itself — so every park was refused with "backend does not
// support parking" and depth-0 ctx.suspend() was dead on the configured
// production backend.
//
// The session here has an outstanding command and a bound requestID, so the
// only remaining reason to refuse is the backend's own verdict: the hybrid
// forwards to the inner ApiBackend, which has no matching activeRun and
// returns false. That is a legitimate refusal. The assertion is that the
// capability RESOLVED — proven by the absence of the not-supported log path,
// which is unreachable once *HybridBackend satisfies backgroundTaskParkable.
func TestBackgroundWake_ParkRoutesThroughHybrid(t *testing.T) {
	// Compile-time proof the capability resolves; a plain runtime call cannot
	// distinguish "refused by the inner" from "assertion failed".
	var _ backgroundTaskParkable = backend.NewHybridBackend()

	hybrid := backend.NewHybridBackend()
	mgr := NewManager(hybrid)
	t.Cleanup(mgr.Shutdown)
	key := "wake-park-hybrid"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 1")

	mgr.mu.Lock()
	mgr.sessions[key].requestID = "run-hybrid-1"
	mgr.mu.Unlock()

	// No activeRun on the inner ApiBackend for this requestID, so the inner
	// declines. What matters is that the call reached it at all.
	if mgr.ParkMainLoop(key) {
		t.Error("expected the inner ApiBackend to decline a park for an unknown requestID")
	}
}

// buildBackgroundWorkInfo maps TaskCompletion fields to BackgroundWorkInfo.
func TestBuildBackgroundWorkInfo(t *testing.T) {
	c := tools.TaskCompletion{
		TaskID:     "bash-42",
		Command:    "npm test",
		Status:     "completed",
		ExitCode:   0,
		ElapsedMs:  9876,
		OutputPath: "/tmp/bash-42.out",
	}
	remaining := []outstandingBackgroundTask{
		{TaskID: "bash-43", Command: "npm build"},
		{TaskID: "bash-44", Command: "npm lint"},
	}
	info := buildBackgroundWorkInfo(c, "wake", remaining)

	if info.Kind != string(types.InjectionKindBackgroundTaskCompletion) {
		t.Errorf("Kind = %q, want %q", info.Kind, types.InjectionKindBackgroundTaskCompletion)
	}
	if info.DeliveryMode != "wake" {
		t.Errorf("DeliveryMode = %q, want wake", info.DeliveryMode)
	}
	if len(info.Items) != 1 {
		t.Fatalf("Items count = %d, want 1", len(info.Items))
	}
	item := info.Items[0]
	if item.ID != "bash-42" {
		t.Errorf("Item.ID = %q, want bash-42", item.ID)
	}
	if item.Source != types.BackgroundWorkSourceBash {
		t.Errorf("Item.Source = %q, want %q", item.Source, types.BackgroundWorkSourceBash)
	}
	if item.Label != "npm test" {
		t.Errorf("Item.Label = %q, want npm test", item.Label)
	}
	if item.Status != "completed" {
		t.Errorf("Item.Status = %q, want completed", item.Status)
	}
	if item.ExitCode != 0 {
		t.Errorf("Item.ExitCode = %d, want 0", item.ExitCode)
	}
	if item.ElapsedMs != 9876 {
		t.Errorf("Item.ElapsedMs = %d, want 9876", item.ElapsedMs)
	}
	if item.OutputPath != "/tmp/bash-42.out" {
		t.Errorf("Item.OutputPath = %q, want /tmp/bash-42.out", item.OutputPath)
	}
	if len(info.RemainingTaskIDs) != 2 {
		t.Fatalf("RemainingTaskIDs count = %d, want 2", len(info.RemainingTaskIDs))
	}
	if info.RemainingTaskIDs[0] != "bash-43" || info.RemainingTaskIDs[1] != "bash-44" {
		t.Errorf("RemainingTaskIDs = %v, want [bash-43 bash-44]", info.RemainingTaskIDs)
	}
}

// buildBackgroundWorkInfo with no remaining tasks produces empty slice.
func TestBuildBackgroundWorkInfo_NoRemaining(t *testing.T) {
	c := tools.TaskCompletion{TaskID: "bash-1", Status: "completed"}
	info := buildBackgroundWorkInfo(c, "steer", nil)
	if len(info.RemainingTaskIDs) != 0 {
		t.Errorf("RemainingTaskIDs = %v, want empty", info.RemainingTaskIDs)
	}
}

// Wake delivery emits engine_background_work_delivered through the backend's
// run-open path (BackgroundWork on prompt overrides).
func TestBackgroundWake_WakeEmitsBackgroundWorkDelivered(t *testing.T) {
	key := "wake-bwd"
	mgr, mb, ec := newWakeManager(t, key, types.BackgroundDeliveryWake)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "make build")

	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "make build"))

	keys := mb.startedInOrder()
	if len(keys) != 1 {
		t.Fatalf("expected 1 run started on wake, got %d", len(keys))
	}

	opts, _ := mb.getStarted(keys[0])
	if opts.BackgroundWork == nil {
		t.Fatal("wake run should carry BackgroundWork metadata on prompt overrides")
	}
	if opts.BackgroundWork.DeliveryMode != types.BackgroundDeliveryWake {
		t.Errorf("BackgroundWork.DeliveryMode = %q, want %q", opts.BackgroundWork.DeliveryMode, types.BackgroundDeliveryWake)
	}
	if len(opts.BackgroundWork.Items) != 1 || opts.BackgroundWork.Items[0].ID != "bash-1" {
		t.Errorf("BackgroundWork.Items = %+v, want single item with ID bash-1", opts.BackgroundWork.Items)
	}

	_ = ec
}

// ParkMainLoop refuses when there is no active run to park.
func TestBackgroundWake_ParkRefusedWithNoActiveRun(t *testing.T) {
	key := "wake-park-norun"
	mgr, _, _ := newWakeManager(t, key, types.BackgroundDeliveryWake)
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 1")

	if mgr.ParkMainLoop(key) {
		t.Error("ParkMainLoop should refuse when there is no active run")
	}
}
