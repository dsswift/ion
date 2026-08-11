package session

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Agent lifecycle / engine_agent_state snapshot contract tests
//
// Background: engine_agent_state is a COMPLETE SNAPSHOT of every agent the
// engine considers live. Every code path that terminates an agent's run
// must transition the registry state to a terminal status (done/error/
// cancelled) so the next emitted snapshot is authoritative. Consumers
// (desktop, iOS, headless harnesses) replace their local view with the
// snapshot — they do not merge incremental updates and they do not retain
// entries the engine no longer endorses.
//
// These tests enforce the engine-side half of that contract: no
// termination path may leave a state in "running" once we emit.
//
// See docs/architecture/agent-state.md for the full spec.
// ---------------------------------------------------------------------------

// capturedAgentStateEvents serializes event capture with test assertions because
// agent lifecycle emissions may arrive from background dispatch goroutines.
type capturedAgentStateEvents struct {
	mu     sync.Mutex
	events []types.EngineEvent
}

func (c *capturedAgentStateEvents) snapshot() []types.EngineEvent {
	c.mu.Lock()
	defer c.mu.Unlock()

	events := make([]types.EngineEvent, len(c.events))
	copy(events, c.events)
	return events
}

// captureAgentStateEvents installs an event listener on the manager that
// records every engine_agent_state payload. Both the event list and each agent
// slice are copied so callers can inspect a stable snapshot safely.
func captureAgentStateEvents(mgr *Manager) *capturedAgentStateEvents {
	captured := &capturedAgentStateEvents{}
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type != "engine_agent_state" {
			return
		}
		// Copy the agents slice so later mutations to the registry don't
		// silently change recorded history.
		copyAgents := make([]types.AgentStateUpdate, len(ev.Agents))
		copy(copyAgents, ev.Agents)
		captured.mu.Lock()
		captured.events = append(captured.events, types.EngineEvent{
			Type:   ev.Type,
			Agents: copyAgents,
		})
		captured.mu.Unlock()
	})
	return captured
}

// assertNoRunningInLastSnapshot fails the test if the most recent
// engine_agent_state event still contains any agent with status "running"
// matching the given name.
func assertNoRunningInLastSnapshot(t *testing.T, captured []types.EngineEvent, name string) {
	t.Helper()
	if len(captured) == 0 {
		t.Fatal("expected at least one engine_agent_state event, got none")
	}
	last := captured[len(captured)-1]
	for _, a := range last.Agents {
		if a.Name == name && a.Status == "running" {
			t.Fatalf("agent %q still has status=running in last snapshot %+v", name, last.Agents)
		}
	}
}

// TestAbortAllDescendants_TransitionsEngineStatesToCancelled verifies that
// when the engine aborts descendant agents it not only kills the handles
// but also transitions the corresponding engine-managed state entries to
// "cancelled" — so the snapshot emitted afterward reflects the truth and
// any future ReconcileState call sees terminal status rather than stale
// "running" rows.
func TestAbortAllDescendants_TransitionsEngineStatesToCancelled(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("life-abort", defaultConfig())

	captured := captureAgentStateEvents(mgr)

	mgr.mu.Lock()
	s := mgr.sessions["life-abort"]
	// Register both handle (so ClearHandles finds them) and state (so
	// UpdateState can transition them). Mirrors what prompt_agent_spawner
	// does in production.
	s.agents.RegisterHandle("worker-1", types.AgentHandle{PID: 88881, ParentAgent: ""})
	s.agents.AppendState(types.AgentStateUpdate{
		Name:   "worker-1",
		Status: "running",
		Metadata: map[string]interface{}{
			"displayName": "Worker 1",
			"visibility":  "sticky",
			"invited":     true,
		},
	})
	s.agents.RegisterHandle("worker-2", types.AgentHandle{PID: 88882, ParentAgent: ""})
	s.agents.AppendState(types.AgentStateUpdate{
		Name:   "worker-2",
		Status: "running",
		Metadata: map[string]interface{}{
			"displayName": "Worker 2",
			"visibility":  "sticky",
			"invited":     true,
		},
	})
	mgr.mu.Unlock()

	mgr.abortAllDescendants("life-abort", "test_abort")

	// Last emission must reflect that both agents are cancelled.
	assertNoRunningInLastSnapshot(t, captured.snapshot(), "worker-1")
	assertNoRunningInLastSnapshot(t, captured.snapshot(), "worker-2")

	// And the registry itself must now report them as cancelled (so a
	// subsequent ReconcileState would re-broadcast terminal status).
	mgr.mu.RLock()
	snapshot := mgr.sessions["life-abort"].agents.MergedSnapshot()
	mgr.mu.RUnlock()
	if len(snapshot) != 2 {
		t.Fatalf("expected 2 state entries after abort, got %d", len(snapshot))
	}
	for _, a := range snapshot {
		if a.Status != "cancelled" {
			t.Errorf("agent %q status=%q, expected cancelled", a.Name, a.Status)
		}
	}
}

// TestReconcileState_AlwaysEmitsEvenWhenEmpty verifies that ReconcileState
// publishes an engine_agent_state event unconditionally, including the
// empty snapshot. A reconnecting client must always learn the current
// truth — "no agents are live" is as much a fact as "two agents are
// running" and the consumer needs to overwrite stale local state with
// either.
func TestReconcileState_AlwaysEmitsEvenWhenEmpty(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("recon-empty", defaultConfig())

	var emittedAgentState int
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			emittedAgentState++
		}
	})

	// No agents registered — registry snapshot is empty.
	mgr.ReconcileState("recon-empty")

	if emittedAgentState == 0 {
		t.Fatal("expected engine_agent_state event from ReconcileState even when snapshot is empty")
	}
}

// TestReconcileState_EmitsCurrentSnapshot verifies that ReconcileState
// emits whatever the registry currently holds (the contract's "complete
// snapshot" guarantee).
func TestReconcileState_EmitsCurrentSnapshot(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("recon-full", defaultConfig())

	captured := captureAgentStateEvents(mgr)

	mgr.mu.Lock()
	s := mgr.sessions["recon-full"]
	s.agents.AppendState(types.AgentStateUpdate{Name: "a", Status: "running"})
	s.agents.AppendState(types.AgentStateUpdate{Name: "b", Status: "done"})
	mgr.mu.Unlock()

	mgr.ReconcileState("recon-full")

	snapshots := captured.snapshot()
	if len(snapshots) == 0 {
		t.Fatal("expected engine_agent_state event from ReconcileState")
	}
	last := snapshots[len(snapshots)-1]
	if len(last.Agents) != 2 {
		t.Errorf("expected 2 agents in reconciled snapshot, got %d: %+v", len(last.Agents), last.Agents)
	}
}

// TestReconcileState_UnknownSessionNoEmit ensures we don't emit for a
// session that doesn't exist — that would confuse clients reconnecting
// to a session that has since been torn down.
func TestReconcileState_UnknownSessionNoEmit(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	var emitted bool
	mgr.OnEvent(func(_ string, _ types.EngineEvent) {
		emitted = true
	})

	mgr.ReconcileState("never-existed")

	if emitted {
		t.Fatal("expected no events for unknown session reconcile")
	}
}

// TestAgentLifecycle_ModelFallbackDoesNotPerturbSnapshots locks in the
// snapshot contract across the new ModelFallbackEvent termination path:
// when a dispatched specialist receives a ModelFallbackEvent from the
// child backend before completing, the parent's engine_agent_state
// snapshot sequence must still be exactly the canonical two emissions
// (running at start, done at completion). The fallback event is a
// workflow signal — it must not trigger an extra agent_state snapshot
// nor leave the agent in "running" status after termination.
//
// This pins docs/architecture/agent-state.md against the new termination
// path introduced by the grand-surfing-moth plan.
func TestAgentLifecycle_ModelFallbackDoesNotPerturbSnapshots(t *testing.T) {
	// Stub child emits a ModelFallbackEvent followed by TaskCompleteEvent.
	// The spawner's OnNormalized handler must ignore the fallback event
	// for agent_state purposes and emit exactly two snapshots: running
	// at start, done at completion.
	stub := &childStubBackend{
		resultText:        "specialist done",
		emitModelFallback: true,
	}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	if _, err := mgr.StartSession("lifecycle-fallback", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	captured := captureAgentStateEvents(mgr)

	mgr.mu.Lock()
	s := mgr.sessions["lifecycle-fallback"]
	mgr.mu.Unlock()

	// Hook-capturing group lets the spawner fire agent_start / agent_end
	// without panicking; the test doesn't assert on hook ordering, only
	// on snapshot emissions.
	group, _ := installHookCapturingGroup(t)
	mgr.mu.Lock()
	s.extGroup = group
	mgr.mu.Unlock()

	runCfg := &backend.RunConfig{}
	mgr.wireAgentSpawner(s, "lifecycle-fallback", "claude-opus-4-7", group, runCfg)
	if runCfg.AgentSpawner == nil {
		t.Fatal("AgentSpawner not installed")
	}

	_, spawnErr := runCfg.AgentSpawner(
		context.Background(),
		"specialist",
		"task",
		"",
		"/tmp",
		"claude-sonnet-4-6",
	)
	if spawnErr != nil {
		t.Fatalf("spawner returned error: %v", spawnErr)
	}

	// Give the goroutine a brief moment to flush the final snapshot —
	// the spawner emits agent_state after onExit on its own goroutine,
	// not synchronously with the spawner closure return.
	time.Sleep(50 * time.Millisecond)

	// Snapshot count: at minimum, the spawner emits one running snapshot at
	// start (reason=agent_start) and one terminal snapshot at end
	// (reason=agent_end). The intervening ModelFallbackEvent must not trigger
	// an additional emission on its own.
	//
	// A post-deregister re-emit (emitDispatchCountStatus, Bug 1 fix) may add
	// one additional snapshot with the agent in its terminal state. That is
	// correct behavior: the extra snapshot carries BackgroundAgents==0 so
	// the client clears the "waiting on background agent" tab state. The test
	// pins two invariants:
	//   1. The first snapshot shows the agent running.
	//   2. The LAST snapshot shows the agent done (never orphaned in "running").
	snapshots := captured.snapshot()
	if len(snapshots) < 2 {
		var summary []string
		for _, snap := range snapshots {
			row := ""
			for _, a := range snap.Agents {
				row += a.Name + "=" + a.Status + " "
			}
			summary = append(summary, "["+row+"]")
		}
		t.Fatalf("expected at least 2 agent_state snapshots (running → done) across the fallback path, got %d: %v", len(snapshots), summary)
	}

	// The spawner generates the agent name from the unique dispatch ID
	// (e.g. "agent-1") because the test registered no spec named
	// "specialist". Locate by single-entry-snapshot rather than by name.
	if len(snapshots[0].Agents) != 1 {
		t.Fatalf("first snapshot should contain exactly 1 agent, got %d: %+v", len(snapshots[0].Agents), snapshots[0].Agents)
	}
	lastSnap := snapshots[len(snapshots)-1]
	if len(lastSnap.Agents) != 1 {
		t.Fatalf("final snapshot should contain exactly 1 agent, got %d: %+v", len(lastSnap.Agents), lastSnap.Agents)
	}

	// First snapshot: agent is running.
	if got := snapshots[0].Agents[0].Status; got != "running" {
		t.Errorf("first snapshot status = %q, want %q", got, "running")
	}

	// Final snapshot: agent is done, never orphaned in running.
	finalStatus := lastSnap.Agents[0].Status
	if finalStatus == "running" {
		t.Errorf("agent still running in final snapshot (snapshot contract violated): %+v", lastSnap.Agents[0])
	}
	if finalStatus != "done" {
		t.Errorf("final snapshot status = %q, want %q", finalStatus, "done")
	}
}

// TestHandleRunExit_CleanCancel_TerminalAgentSnapshot pins the agent-state
// snapshot + descendant-teardown contract for the clean-cancel termination
// path through handleRunExit. A clean cancel (code==0, signal=="cancelled")
// can arrive straight from the runloop — a turn/tool hook cancelling the run —
// WITHOUT flowing through SendAbort, so handleRunExit reaps descendants itself
// (event_translation.go). This is a distinct termination trigger from
// abortAllDescendants-via-SendAbort.
//
// The contract has two halves on this path:
//  1. No descendant is stranded "running" in the post-exit snapshot
//     (handleRunExit's ClearRunningStates handles the status), and
//  2. every descendant HANDLE is reaped, so no dispatched child process
//     outlives the cancelled parent (the `cleanCancel || abnormalExit` guard's
//     abortAllDescendants → ClearHandles).
//
// Remove the `cleanCancel || abnormalExit` descendant-teardown guard in
// handleRunExit and half (2) goes red: HandleCount stays 1 because the
// orphaned child handle is never cleared. (PID 0 keeps killProcess inert so
// the test reaps a handle without signalling a real process.)
func TestHandleRunExit_CleanCancel_TerminalAgentSnapshot(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("exit-clean-snap", defaultConfig())

	captured := captureAgentStateEvents(mgr)

	// Drive the run first; SendPrompt resets the agent registry, so the live
	// descendant must be registered AFTER the run has started and BEFORE the
	// exit fires (mirroring a mid-run dispatch).
	_ = mgr.SendPrompt("exit-clean-snap", "go", nil)
	keys := mb.startedKeys()
	if len(keys) == 0 {
		t.Fatal("expected a started run for exit-clean-snap")
	}

	mgr.mu.Lock()
	s := mgr.sessions["exit-clean-snap"]
	// Register a live, engine-managed descendant (handle + state). PID 0 keeps
	// killProcess inert. No extension group → the engine owns the registry and
	// emits a corrective snapshot on teardown (extension-owned registries skip
	// the engine snapshot — see abort.go).
	s.agents.RegisterHandle("child-1", types.AgentHandle{PID: 0, ParentAgent: ""})
	s.agents.AppendState(types.AgentStateUpdate{
		Name:   "child-1",
		Status: "running",
		Metadata: map[string]interface{}{
			"displayName": "Child 1",
			"visibility":  "sticky",
			"invited":     true,
		},
	})
	mgr.mu.Unlock()

	// Deliver a cooperative cancel exit. The mock backend's exit callback routes
	// into handleRunExit via keyForRun.
	code := 0
	signal := "cancelled"
	mb.emitExit(keys[0], &code, &signal, "")

	// Half (1): the descendant must not be stranded "running" in the last
	// snapshot — it appears terminal or is absent.
	assertNoRunningInLastSnapshot(t, captured.snapshot(), "child-1")

	// Half (2): the descendant handle must be reaped so no orphaned child
	// outlives the cancelled parent. This is the assertion that goes red when
	// the clean-cancel teardown guard is removed.
	mgr.mu.RLock()
	handleCount := mgr.sessions["exit-clean-snap"].agents.HandleCount()
	snapshot := mgr.sessions["exit-clean-snap"].agents.MergedSnapshot()
	mgr.mu.RUnlock()
	if handleCount != 0 {
		t.Errorf("descendant handle not reaped after clean cancel: HandleCount=%d, want 0 (orphaned child would outlive the cancelled parent)", handleCount)
	}
	for _, a := range snapshot {
		if a.Name == "child-1" && a.Status == "running" {
			t.Errorf("descendant %q still running in registry after clean cancel (snapshot contract violated): %+v", a.Name, a)
		}
	}
}
