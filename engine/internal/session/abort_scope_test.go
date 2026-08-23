package session

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// abort_scope_test.go — scoped abort behavior.
//
// The distinction these pin is not observable from "did the run stop?" (both
// scopes stop the run). It is observable from what SURVIVES: the session
// cancellation root and the background dispatches hanging off it.

// registerTestDispatch puts a live dispatch in the session's registry and
// reports whether its cancel func fired, so a test can assert recall/no-recall
// without a real child backend.
func registerTestDispatch(s *engineSession, id, name string) *bool {
	cancelled := false
	s.dispatchRegistry.RegisterWithID(id, name, func() { cancelled = true }, nil, s.key, "", 1)
	return &cancelled
}

// TestSendAbortScoped_OrchestratorSparesRootAndDispatches is the core pin for
// the orchestrator scope: the run is cancelled, but the session cancellation
// root stays LIVE and background dispatches stay registered and un-cancelled.
//
// Revert the scope fork in SendAbortScoped and this goes red on the first
// assertion — the root is cancelled, which cascades to every dispatch context.
func TestSendAbortScoped_OrchestratorSparesRootAndDispatches(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("scoped-orch", defaultConfig())
	_ = mgr.SendPrompt("scoped-orch", "start", nil)

	s := mgr.sessions["scoped-orch"]
	cancelled := registerTestDispatch(s, "dispatch-a-1", "researcher")

	mgr.SendAbortScoped("scoped-orch", AbortScopeOrchestrator)

	// The run itself is cancelled — an orchestrator stop is still a stop.
	mb.mu.Lock()
	cancelCount := len(mb.cancelled)
	mb.mu.Unlock()
	if cancelCount == 0 {
		t.Error("expected backend Cancel to be called for the active run")
	}

	// THE ASSERTION: the session root survives, so dispatch contexts derived
	// from it are untouched.
	if err := s.rootContext().Err(); err != nil {
		t.Fatalf("session root was cancelled under orchestrator scope (%v) — every background dispatch would die with it", err)
	}

	// And the dispatch is still live in the registry, never recalled.
	if *cancelled {
		t.Error("background dispatch was cancelled under orchestrator scope")
	}
	if len(s.dispatchRegistry.ActiveIDs()) != 1 {
		t.Errorf("expected 1 live dispatch after orchestrator abort, got %d", len(s.dispatchRegistry.ActiveIDs()))
	}
}

// TestSendAbortScoped_AllCancelsRootAndRecallsDispatches pins the unchanged
// full-teardown behavior: root cancelled, registry emptied by recall.
func TestSendAbortScoped_AllCancelsRootAndRecallsDispatches(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("scoped-all", defaultConfig())
	_ = mgr.SendPrompt("scoped-all", "start", nil)

	s := mgr.sessions["scoped-all"]
	cancelled := registerTestDispatch(s, "dispatch-b-1", "researcher")

	mgr.SendAbortScoped("scoped-all", AbortScopeAll)

	if err := s.rootContext().Err(); err == nil {
		t.Error("expected session root to be cancelled under all scope")
	}
	if !*cancelled {
		t.Error("expected background dispatch to be recalled under all scope")
	}
	if n := len(s.dispatchRegistry.ActiveIDs()); n != 0 {
		t.Errorf("expected registry emptied after all-scope abort, got %d live", n)
	}
}

// TestSendAbortScoped_AllWorkStopsOwnedBackgroundTasks starts real Bash
// processes, then proves all_work stops only the session-owned process and
// leaves the session reusable. Reverting the all_work arm leaves its process
// live and makes this regression test fail.
func TestSendAbortScoped_AllWorkStopsOwnedBackgroundTasks(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("all-work", defaultConfig())
	_ = mgr.SendPrompt("all-work", "start", nil)

	ownedCtx := tools.WithBackgroundTaskOwner(context.Background(), "all-work")
	otherCtx := tools.WithBackgroundTaskOwner(context.Background(), "other")
	if _, err := tools.ExecuteTool(ownedCtx, "Bash", map[string]any{"command": "sleep 60", "run_in_background": true}, t.TempDir()); err != nil {
		t.Fatalf("start owned background task: %v", err)
	}
	if _, err := tools.ExecuteTool(otherCtx, "Bash", map[string]any{"command": "sleep 60", "run_in_background": true}, t.TempDir()); err != nil {
		t.Fatalf("start unrelated background task: %v", err)
	}
	t.Cleanup(func() { tools.StopBackgroundTasksForOwner("all-work"); tools.StopBackgroundTasksForOwner("other") })
	if got := tools.BackgroundTasksForOwner("all-work"); len(got) != 1 {
		t.Fatalf("owned live task count = %d, want 1", len(got))
	}

	mgr.SendAbortScoped("all-work", AbortScopeAllWork)
	mb.emitExit(mb.startedInOrder()[0], intPtr(0), strPtr("cancelled"), "")
	if got := tools.BackgroundTasksForOwner("all-work"); len(got) != 0 {
		t.Fatalf("owned live task count = %d after all_work, want 0", len(got))
	}
	if got := tools.BackgroundTasksForOwner("other"); len(got) != 1 {
		t.Fatalf("other live task count = %d after all_work, want 1", len(got))
	}

	if err := mgr.SendPrompt("all-work", "next", nil); err != nil {
		t.Fatalf("session must remain reusable after all_work abort: %v", err)
	}
	if len(mb.startedInOrder()) < 2 {
		t.Fatal("expected a new run after all_work abort rearmed the session root")
	}
}

// TestSendAbort_DefaultsToAllScope pins that the pre-scope entry point still
// means full teardown. External Go-SDK consumers call SendAbort directly.
func TestSendAbort_DefaultsToAllScope(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("default-scope", defaultConfig())
	_ = mgr.SendPrompt("default-scope", "start", nil)

	s := mgr.sessions["default-scope"]
	cancelled := registerTestDispatch(s, "dispatch-c-1", "researcher")

	mgr.SendAbort("default-scope")

	if err := s.rootContext().Err(); err == nil {
		t.Error("SendAbort must cancel the session root (all scope)")
	}
	if !*cancelled {
		t.Error("SendAbort must recall background dispatches (all scope)")
	}
}

// TestSendAbortScoped_OrchestratorStillDropsQueuedPrompts: an orchestrator stop
// still means "abandon the pending work" for the orchestrator. The queue is
// the orchestrator's, not the dispatches'.
func TestSendAbortScoped_OrchestratorStillDropsQueuedPrompts(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("scoped-queue", defaultConfig())
	_ = mgr.SendPrompt("scoped-queue", "first", nil)
	// Second prompt queues behind the in-flight run.
	_ = mgr.SendPrompt("scoped-queue", "queued", nil)

	s := mgr.sessions["scoped-queue"]
	if len(s.promptQueue) == 0 {
		t.Fatal("precondition failed: expected a queued prompt")
	}

	mgr.SendAbortScoped("scoped-queue", AbortScopeOrchestrator)

	mgr.mu.Lock()
	remaining := len(s.promptQueue)
	mgr.mu.Unlock()
	if remaining != 0 {
		t.Errorf("expected queued prompts dropped under orchestrator scope, got %d", remaining)
	}
}

// TestSendAbortScoped_UnknownSessionNoPanic covers both scopes on a session
// that does not exist.
func TestSendAbortScoped_UnknownSessionNoPanic(t *testing.T) {
	mgr := NewManager(newMockBackend())
	mgr.SendAbortScoped("ghost", AbortScopeOrchestrator)
	mgr.SendAbortScoped("ghost", AbortScopeAll)
}

// ---------------------------------------------------------------------------
// handleRunExit — the no-reap marker
// ---------------------------------------------------------------------------

// TestHandleRunExit_OrchestratorAbortSkipsReap is the second half of the
// orchestrator scope, and the half that is easy to miss: sparing the root at
// abort time is pointless if the run's EXIT then reaps the dispatches anyway.
// handleRunExit reaps on any cancelled exit, and an orchestrator-scoped abort
// is indistinguishable there from any other cancel without the marker.
//
// Remove the skipDescendantReap branch in handleRunExit and this goes red.
func TestHandleRunExit_OrchestratorAbortSkipsReap(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("exit-skip", defaultConfig())
	_ = mgr.SendPrompt("exit-skip", "start", nil)

	s := mgr.sessions["exit-skip"]
	cancelled := registerTestDispatch(s, "dispatch-live", "researcher")

	runID := mb.startedInOrder()[0]
	mgr.SendAbortScoped("exit-skip", AbortScopeOrchestrator)
	// The cancelled run unwinds and reports the cooperative cancel signal.
	mb.emitExit(runID, intPtr(0), strPtr("cancelled"), "")

	if *cancelled {
		t.Fatal("run exit reaped the background dispatch after an orchestrator-scoped abort — the scope was undone at exit")
	}
	if n := len(s.dispatchRegistry.ActiveIDs()); n != 1 {
		t.Errorf("expected the dispatch to survive run exit, got %d live", n)
	}
}

// TestHandleRunExit_OrdinaryCancelStillReaps is the counterpart: the marker
// must not suppress the reap for a cancel that did NOT come from an
// orchestrator-scoped abort (e.g. a turn/tool hook cancelling the run). This is
// what keeps the pre-existing guarantee that children never outlive a
// cancelled parent.
func TestHandleRunExit_OrdinaryCancelStillReaps(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("exit-reap", defaultConfig())
	_ = mgr.SendPrompt("exit-reap", "start", nil)

	s := mgr.sessions["exit-reap"]
	cancelled := registerTestDispatch(s, "dispatch-doomed", "researcher")

	runID := mb.startedInOrder()[0]
	// No abort at all — the runloop cancelled itself.
	mb.emitExit(runID, intPtr(0), strPtr("cancelled"), "")

	if !*cancelled {
		t.Fatal("an ordinary clean cancel must still reap descendants")
	}
}

// TestHandleRunExit_MarkerIsOneShot pins the run-scoping: the marker suppresses
// exactly the run it named. A LATER ordinary cancel on the same session must
// reap normally, or one scoped stop would permanently disarm the safety net.
func TestHandleRunExit_MarkerIsOneShot(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("exit-oneshot", defaultConfig())
	_ = mgr.SendPrompt("exit-oneshot", "first", nil)

	s := mgr.sessions["exit-oneshot"]
	first := mb.startedInOrder()[0]
	mgr.SendAbortScoped("exit-oneshot", AbortScopeOrchestrator)
	mb.emitExit(first, intPtr(0), strPtr("cancelled"), "")

	// Second run on the same session, cancelled the ordinary way.
	_ = mgr.SendPrompt("exit-oneshot", "second", nil)
	order := mb.startedInOrder()
	if len(order) != 2 {
		t.Fatalf("expected a second run to dispatch, got %d", len(order))
	}
	cancelled := registerTestDispatch(s, "dispatch-second", "researcher")
	mb.emitExit(order[1], intPtr(0), strPtr("cancelled"), "")

	if !*cancelled {
		t.Fatal("the no-reap marker leaked into a later run — one scoped stop disarmed the reap permanently")
	}
}

// ---------------------------------------------------------------------------
// ParseAbortScope
// ---------------------------------------------------------------------------

// TestParseAbortScope covers the wire mapping, including the two defaults that
// protect older clients and malformed input.
func TestParseAbortScope(t *testing.T) {
	cases := []struct {
		raw  string
		want AbortScope
	}{
		{"", AbortScopeAll},                      // absent field: pre-scope clients
		{"all", AbortScopeAll},                   // explicit
		{"all_work", AbortScopeAllWork},          // explicit
		{"orchestrator", AbortScopeOrchestrator}, // explicit
		{"nonsense", AbortScopeAll},              // unknown: safe default
		{"Orchestrator", AbortScopeAll},          // case-sensitive by design
	}
	for _, tc := range cases {
		if got := ParseAbortScope(tc.raw); got != tc.want {
			t.Errorf("ParseAbortScope(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// AbortDispatch
// ---------------------------------------------------------------------------

// newDispatchAbortSession builds a bare session with a dispatch registry,
// bypassing StartSession so the test controls exactly what is registered.
func newDispatchAbortSession(key string) (*Manager, *engineSession) {
	m := &Manager{
		sessions: make(map[string]*engineSession),
		onEvent:  func(_ string, _ types.EngineEvent) {},
	}
	s := &engineSession{
		key:              key,
		agents:           agents.NewRegistry(),
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		pending:          pending.New(),
	}
	m.sessions[key] = s
	return m, s
}

// TestAbortDispatch_RecallsTargetAndCascadesLeavingSiblings is the core pin for
// per-dispatch abort: the addressed dispatch and its descendants stop, and an
// unrelated sibling keeps running.
func TestAbortDispatch_RecallsTargetAndCascadesLeavingSiblings(t *testing.T) {
	m, s := newDispatchAbortSession("dispatch-abort")

	targetCancelled := false
	childCancelled := false
	siblingCancelled := false
	s.dispatchRegistry.RegisterWithID("target", "dev-lead", func() { targetCancelled = true }, nil, s.key, "", 1)
	// Child of target: parentID wires the cascade.
	s.dispatchRegistry.RegisterWithID("child", "specialist", func() { childCancelled = true }, nil, s.key, "target", 2)
	s.dispatchRegistry.RegisterWithID("sibling", "reviewer", func() { siblingCancelled = true }, nil, s.key, "", 1)

	if !m.AbortDispatch("dispatch-abort", "target", "user abort (dispatch)") {
		t.Fatal("AbortDispatch returned false for a live dispatch")
	}

	if !targetCancelled {
		t.Error("target dispatch was not cancelled")
	}
	if !childCancelled {
		t.Error("descendant dispatch was not cancelled (cascade broken)")
	}
	if siblingCancelled {
		t.Error("sibling dispatch was cancelled — per-dispatch abort must not touch peers")
	}

	active := s.dispatchRegistry.ActiveIDs()
	if !active["sibling"] {
		t.Error("sibling should remain registered and live")
	}
	if active["target"] || active["child"] {
		t.Error("recalled dispatches should be deregistered")
	}
}

// TestAbortDispatch_UnknownIDReturnsFalse: a dispatch that finished between the
// consumer rendering Stop and the command arriving is a normal miss, not an
// error or a panic.
func TestAbortDispatch_UnknownIDReturnsFalse(t *testing.T) {
	m, s := newDispatchAbortSession("dispatch-miss")
	s.dispatchRegistry.RegisterWithID("live", "dev-lead", func() {}, nil, s.key, "", 1)

	if m.AbortDispatch("dispatch-miss", "already-finished", "user abort (dispatch)") {
		t.Error("expected false for an unknown dispatch id")
	}
	if len(s.dispatchRegistry.ActiveIDs()) != 1 {
		t.Error("a missed recall must not disturb live dispatches")
	}
}

// TestAbortDispatch_UnknownSessionNoPanic pins the nil-session guard.
func TestAbortDispatch_UnknownSessionNoPanic(t *testing.T) {
	m, _ := newDispatchAbortSession("real")
	if m.AbortDispatch("ghost", "whatever", "user abort (dispatch)") {
		t.Error("expected false for an unknown session")
	}
}

// ---------------------------------------------------------------------------
// abortAllDescendants — registry recall (gap-4 regression pin)
// ---------------------------------------------------------------------------

// TestAbortAllDescendants_RecallsDispatchesWithZeroHandles is the direct
// regression pin for the defect this change fixes: engine-native dispatches
// register NO process handle, so the handle sweep's `len(pids) == 0` early
// return fired before anything stopped them. A recall placed after that return
// never executes.
//
// Move the RecallAll call below the early return and this goes red.
func TestAbortAllDescendants_RecallsDispatchesWithZeroHandles(t *testing.T) {
	m, s := newDispatchAbortSession("zero-handles")

	recalled := false
	s.dispatchRegistry.RegisterWithID("d1", "researcher", func() { recalled = true }, nil, s.key, "", 1)

	// No agent handles registered at all — the engine-native dispatch case.
	if s.agents.HandleCount() != 0 {
		t.Fatal("precondition failed: expected zero agent handles")
	}

	m.abortAllDescendants("zero-handles", "test reap")

	if !recalled {
		t.Fatal("background dispatch survived abortAllDescendants — the zero-handle early return skipped the registry recall")
	}
	if n := len(s.dispatchRegistry.ActiveIDs()); n != 0 {
		t.Errorf("expected registry emptied, got %d live", n)
	}
}

// TestAbortAgentCompatibilityEmptySubtreeReapsDispatches pins the retained
// abort_agent empty-name subtree form. It must still reach the shared
// descendant teardown, not only the newer exact-ID command.
func TestAbortAgentCompatibilityEmptySubtreeReapsDispatches(t *testing.T) {
	m, s := newDispatchAbortSession("compat-subtree")
	cancelled := false
	s.dispatchRegistry.RegisterWithID("legacy-child", "worker", func() { cancelled = true }, nil, s.key, "", 1)

	m.AbortAgent("compat-subtree", "", true)
	if !cancelled {
		t.Fatal("abort_agent empty subtree did not recall the live dispatch")
	}
	if len(s.dispatchRegistry.ActiveIDs()) != 0 {
		t.Fatal("abort_agent empty subtree left a live dispatch registered")
	}
}
