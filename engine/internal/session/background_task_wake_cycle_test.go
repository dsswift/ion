package session

import (
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// background_task_wake_cycle_test.go is the acceptance test for the requested
// workflow:
//
//	start a background command, keep working, start another, keep working,
//	end the turn with several outstanding, park, then wake once per
//	completion — each wake naming what is still running — re-parking until
//	the set empties, and only then completing normally.
//
// It exercises the session-layer half of that cycle end to end (registration
// across runs, park, per-completion wake, re-park, final completion). The
// run-loop half — the turn-boundary decision to park rather than complete —
// is pinned in backend/runloop_background_park_test.go.

// parkAfterRunExit drives the REAL park path a turn boundary takes: the run
// loop emits TaskSuspendEvent carrying the outstanding task IDs, then emits the
// run's exit (parkForBackgroundTasks does both, in that order).
//
// Both halves go through the manager's actual event callbacks —
// handleNormalizedEvent and handleRunExit — rather than reaching into session
// state. That matters: an earlier version of this helper called
// markSessionParked and then cleared s.requestID by hand, which ENCODED the
// assumption that parking clears the run binding instead of testing it. The
// park path did not emit an exit, so in production requestID survived, a parked
// session still looked busy, and a completion arriving while parked took the
// steer branch and was dropped against a dead run. The hand-clear hid it.
// Drive the events, never the state.
func parkAfterRunExit(t *testing.T, mgr *Manager, key string) {
	t.Helper()
	outstanding := mgr.OutstandingBackgroundTaskIDs(key)
	if len(outstanding) == 0 {
		t.Fatalf("cannot park %q: nothing outstanding", key)
	}

	mgr.mu.RLock()
	s, ok := mgr.sessions[key]
	runID := ""
	convID := ""
	if ok {
		runID = s.requestID
		convID = s.conversationID
	}
	mgr.mu.RUnlock()
	if !ok {
		t.Fatalf("session %q not found", key)
	}
	if runID == "" {
		t.Fatalf("cannot park %q: no active run to park (test must start one first)", key)
	}

	// 1. The suspend event — the session records the park off this.
	mgr.handleNormalizedEvent(runID, types.NormalizedEvent{Data: &types.TaskSuspendEvent{
		AwaitingTaskIDs: outstanding,
	}})
	// 2. The run's exit — clean (code 0, no signal), which is what a park is.
	//    This is what clears requestID and unbinds the run key.
	mgr.handleRunExit(runID, intPtr(0), nil, convID)
}

// startRun puts the session into the running state the way a dispatch does, so
// a test can then park it. Returns the requestID.
func startRun(t *testing.T, mgr *Manager, key string) string {
	t.Helper()
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	s, ok := mgr.sessions[key]
	if !ok {
		t.Fatalf("session %q not found", key)
	}
	runID := key + "-run"
	s.requestID = runID
	mgr.bindRunLocked(runID, key)
	return runID
}

// TestBackgroundCycle_MultiTaskParkWakeRepark walks the full workflow with
// three commands registered across two separate runs.
func TestBackgroundCycle_MultiTaskParkWakeRepark(t *testing.T) {
	key := "cycle"
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// ── Turn 1: start two commands, keep working, end the turn ──────────────
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 20")
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "sleep 40")

	// ── Turn 2 (a separate run): start a third ──────────────────────────────
	// The set is session-scoped, so all three are outstanding even though they
	// were registered by different runs.
	mgr.registerOutstandingBackgroundTask(key, "bash-3", "sleep 60")

	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 3 {
		t.Fatalf("outstanding after two runs = %v, want all three tracked", got)
	}

	// ── The run ends with work outstanding: the session parks ───────────────
	startRun(t, mgr, key)
	parkAfterRunExit(t, mgr, key)
	assertParked(t, mgr, key, true)

	runsBefore := len(mb.startedInOrder())

	// ── bash-1 completes: exactly one wake, naming the two still running ────
	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "sleep 20"))

	runsAfterFirst := len(mb.startedInOrder())
	if runsAfterFirst != runsBefore+1 {
		t.Fatalf("expected exactly one run started by the first completion, got %d new", runsAfterFirst-runsBefore)
	}
	firstPrompt := lastPrompt(t, mb)
	if !strings.Contains(firstPrompt, "bash-1") {
		t.Errorf("first wake should report bash-1; got:\n%s", firstPrompt)
	}
	for _, want := range []string{"bash-2", "bash-3"} {
		if !strings.Contains(firstPrompt, want) {
			t.Errorf("first wake should list %s as still running; got:\n%s", want, firstPrompt)
		}
	}
	assertParked(t, mgr, key, false) // the wake claimed the park

	// ── That run ends its turn with two still outstanding: park again ───────
	remaining := mgr.OutstandingBackgroundTaskIDs(key)
	if len(remaining) != 2 {
		t.Fatalf("outstanding after first completion = %v, want 2", remaining)
	}
	startRun(t, mgr, key)
	parkAfterRunExit(t, mgr, key)
	assertParked(t, mgr, key, true)

	// ── bash-2 completes: wake again, one still running ─────────────────────
	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-2", "sleep 40"))

	secondPrompt := lastPrompt(t, mb)
	if !strings.Contains(secondPrompt, "bash-2") {
		t.Errorf("second wake should report bash-2; got:\n%s", secondPrompt)
	}
	if !strings.Contains(secondPrompt, "bash-3") {
		t.Errorf("second wake should list bash-3 as still running; got:\n%s", secondPrompt)
	}
	if strings.Contains(secondPrompt, "Still running") && strings.Contains(secondPrompt, "bash-1") {
		t.Errorf("second wake should not list the already-finished bash-1; got:\n%s", secondPrompt)
	}

	// ── Park once more, then the last one completes ─────────────────────────
	startRun(t, mgr, key)
	parkAfterRunExit(t, mgr, key)
	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-3", "sleep 60"))

	finalPrompt := lastPrompt(t, mb)
	if !strings.Contains(finalPrompt, "bash-3") {
		t.Errorf("final wake should report bash-3; got:\n%s", finalPrompt)
	}
	if !strings.Contains(finalPrompt, "No background commands remain outstanding") {
		t.Errorf("final wake should state that nothing remains; got:\n%s", finalPrompt)
	}

	// ── The set is empty, so the next turn boundary completes normally ──────
	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 0 {
		t.Errorf("outstanding after all completions = %v, want empty", got)
	}
	assertParked(t, mgr, key, false)

	// Three completions, three wakes, three typed events — one per command.
	if evs := ec.byType("engine_background_task_complete"); len(evs) != 3 {
		t.Errorf("typed completion events = %d, want 3 (one per command)", len(evs))
	}
	if total := len(mb.startedInOrder()); total != runsBefore+3 {
		t.Errorf("runs started = %d, want exactly one wake per completion", total-runsBefore)
	}
}

// Two commands finishing at the same instant must start exactly one run. The
// drain-and-claim happens under a single lock hold, so the second completion
// observes the park already claimed and does not start a competing run.
func TestBackgroundCycle_SimultaneousCompletionsStartOneRun(t *testing.T) {
	key := "cycle-race"
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "one")
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "two")
	startRun(t, mgr, key)
	parkAfterRunExit(t, mgr, key)

	var wg sync.WaitGroup
	wg.Add(2)
	for _, id := range []string{"bash-1", "bash-2"} {
		go func(taskID string) {
			defer wg.Done()
			mgr.onBackgroundTaskComplete(testCompletion(key, taskID, taskID))
		}(id)
	}
	wg.Wait()

	// Exactly one completion claims the park. The other finds no park to claim
	// and — with no active run in the mock — routes to the wake path only if it
	// also observes the session idle, so at most two runs may start; what must
	// never happen is the park being claimed twice.
	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 0 {
		t.Errorf("outstanding after both completions = %v, want empty", got)
	}
	assertParked(t, mgr, key, false)
}

// The park timeout wakes a stranded session and leaves the stuck commands
// outstanding, so a slow command still notifies when it eventually exits.
func TestBackgroundCycle_ParkTimeoutWakesAndKeepsTasks(t *testing.T) {
	key := "cycle-timeout"
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-stuck", "sleep infinity")
	startRun(t, mgr, key)
	parkAfterRunExit(t, mgr, key)

	mgr.onParkTimeout(key)

	prompt := lastPrompt(t, mb)
	if !strings.Contains(prompt, "bash-stuck") {
		t.Errorf("timeout wake should name the stuck command; got:\n%s", prompt)
	}
	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 1 {
		t.Errorf("outstanding after timeout = %v, want the stuck task still tracked", got)
	}
	assertParked(t, mgr, key, false)

	// The command eventually finishes and still notifies normally.
	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-stuck", "sleep infinity"))
	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 0 {
		t.Errorf("outstanding after the late completion = %v, want empty", got)
	}
}

// The park timeout honors the configured delivery mode. `event_only` is
// documented as the operator's off switch for unattended runs, so a session
// that parks and then strands must NOT start a run when the timeout fires —
// the park is cleared (the session must not stay wedged) and the stuck
// commands stay tracked, but nothing runs unattended.
//
// Red before the mode gate in onParkTimeout: the timeout called
// wakeSessionWithPayload unconditionally, so `event_only` and `queue` both got
// an unattended run 30 minutes after any park.
func TestBackgroundCycle_ParkTimeoutHonorsDeliveryMode(t *testing.T) {
	for _, tc := range []struct {
		mode     string
		wantRuns int
	}{
		{types.BackgroundDeliveryWake, 1},
		{types.BackgroundDeliveryQueue, 0},
		{types.BackgroundDeliveryEventOnly, 0},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			key := "cycle-timeout-" + tc.mode
			mgr, mb, _ := newWakeManager(t, key, tc.mode)
			mgr.registerOutstandingBackgroundTask(key, "bash-stuck", "sleep infinity")
			startRun(t, mgr, key)
			parkAfterRunExit(t, mgr, key)
			runsBefore := len(mb.startedInOrder())

			mgr.onParkTimeout(key)

			started := len(mb.startedInOrder()) - runsBefore
			if started != tc.wantRuns {
				t.Errorf("runs started on park timeout under delivery=%s = %d, want %d",
					tc.mode, started, tc.wantRuns)
			}
			// Regardless of mode the park is released — a wedged command must
			// never strand the session — and the task stays tracked so it
			// still notifies when it eventually exits.
			assertParked(t, mgr, key, false)
			if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 1 {
				t.Errorf("outstanding after timeout = %v, want the stuck task still tracked", got)
			}
		})
	}
}

// A session that never uses notify_on_complete never parks and never wakes:
// the no-regression pin for existing background usage.
func TestBackgroundCycle_NoNotifyingTasksNeverParks(t *testing.T) {
	key := "cycle-plain"
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 0 {
		t.Fatalf("a session with no notifying commands must report nothing outstanding, got %v", got)
	}
	// The run loop consults exactly this; empty means "complete normally".
	assertParked(t, mgr, key, false)
	if keys := mb.startedInOrder(); len(keys) != 0 {
		t.Errorf("no run should have been started, got %d", len(keys))
	}
}

func assertParked(t *testing.T, mgr *Manager, key string, want bool) {
	t.Helper()
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	s, ok := mgr.sessions[key]
	if !ok {
		t.Fatalf("session %q not found", key)
	}
	if got := s.parked != nil; got != want {
		t.Errorf("parked = %v, want %v", got, want)
	}
}

// lastPrompt returns the prompt of the most recently started run. Uses
// startedInOrder (not startedKeys, which iterates a map in random order) so
// "the most recent run" is deterministic.
func lastPrompt(t *testing.T, mb *mockBackend) string {
	t.Helper()
	order := mb.startedInOrder()
	if len(order) == 0 {
		t.Fatal("no run has been started")
	}
	last := order[len(order)-1]
	opts, ok := mb.getStarted(last)
	if !ok {
		t.Fatalf("run %q not found in the mock backend", last)
	}
	return opts.Prompt
}

// TestBackgroundCycle_ParkClearsRunBinding is the regression test for the
// defect that shipped: parkForBackgroundTasks emitted TaskSuspendEvent but no
// exit, so handleRunExit never ran, engineSession.requestID survived, and the
// session still looked busy while parked.
//
// The consequence was silent and total: onBackgroundTaskComplete reads
// requestID to decide between the mid-turn steer path and the wake path, so a
// completion arriving while parked took the steer branch, landed on a run that
// had already returned, and was dropped. The session was never woken for it.
// Observed live as "completion delivered to active run via steer" logged six
// seconds AFTER "session parked on outstanding background commands".
//
// Asserts the invariant the wake path depends on: after a park, the session is
// genuinely idle.
func TestBackgroundCycle_ParkClearsRunBinding(t *testing.T) {
	key := "cycle-binding"
	mgr := NewManager(newMockBackend())
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 30")

	runID := startRun(t, mgr, key)
	if got := mgr.OutstandingBackgroundTaskIDs(key); len(got) != 1 {
		t.Fatalf("precondition: outstanding = %v, want 1", got)
	}

	parkAfterRunExit(t, mgr, key)

	mgr.mu.RLock()
	s := mgr.sessions[key]
	requestID := s.requestID
	parked := s.parked != nil
	mgr.mu.RUnlock()

	if requestID != "" {
		t.Errorf("requestID = %q after park, want empty — a parked session must not look busy, "+
			"or an arriving completion steers into a dead run instead of waking the session", requestID)
	}
	if !parked {
		t.Error("expected the session to be recorded as parked")
	}
	// The run key binding must be gone too, so a late event for the dead run
	// cannot resolve back to this session.
	if boundKey := mgr.keyForRun(runID); boundKey != "" {
		t.Errorf("run %q still bound to key %q after park, want unbound", runID, boundKey)
	}
}

// A completion arriving while the session is parked must WAKE it, not steer
// into the run that already exited. This is the behavioral half of the
// regression above: it fails on the unfixed engine because the completion takes
// the steer branch and no run is ever started.
func TestBackgroundCycle_CompletionWhileParkedWakesNotSteers(t *testing.T) {
	key := "cycle-parked-wake"
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 30")
	mgr.registerOutstandingBackgroundTask(key, "bash-2", "sleep 60")

	startRun(t, mgr, key)
	parkAfterRunExit(t, mgr, key)
	runsBefore := len(mb.startedInOrder())

	// First completion arrives while parked.
	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "sleep 30"))

	runsAfter := len(mb.startedInOrder())
	if runsAfter != runsBefore+1 {
		t.Fatalf("expected the parked session to be woken with exactly one new run, got %d new "+
			"(a completion arriving while parked must not be steered into the exited run)", runsAfter-runsBefore)
	}
	prompt := lastPrompt(t, mb)
	if !strings.Contains(prompt, "bash-1") {
		t.Errorf("wake prompt should carry the completed task; got:\n%s", prompt)
	}
	if !strings.Contains(prompt, "bash-2") {
		t.Errorf("wake prompt should list bash-2 as still outstanding; got:\n%s", prompt)
	}
}

// A run starting while parked (a queued prompt drained by handleRunExit on the
// park's own exit, or a user prompt typed while parked) clears the park record.
// Otherwise a completion arriving afterwards would claim a stale park and start
// a SECOND concurrent run alongside the one already going.
func TestBackgroundCycle_RunStartClearsStalePark(t *testing.T) {
	key := "cycle-stale-park"
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.registerOutstandingBackgroundTask(key, "bash-1", "sleep 30")

	startRun(t, mgr, key)
	parkAfterRunExit(t, mgr, key)
	assertParked(t, mgr, key, true)

	// Something starts a run while the session is parked.
	if err := mgr.SendPrompt(key, "user typed this while parked", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	assertParked(t, mgr, key, false)

	runsAfterPrompt := len(mb.startedInOrder())

	// The completion now arrives. The session is running, so this must be
	// steered in — NOT treated as a wake that starts a competing run.
	mgr.onBackgroundTaskComplete(testCompletion(key, "bash-1", "sleep 30"))

	if got := len(mb.startedInOrder()); got != runsAfterPrompt {
		t.Errorf("runs = %d, want %d — a completion arriving during a live run must not start "+
			"another run by claiming a stale park record", got, runsAfterPrompt)
	}
}
