package session

// Tests for the client-tool pending-state owner (client_tool_state.go) and
// the machine client-tool round-trip: the engine_client_tool_state snapshot
// lifecycle including the authoritative empty-array clear, cancellation
// cleanup, and reconcile replay. Human-wait tools no longer pend here — they
// PARK the run (see backend/runloop_human_wait_park_test.go); machine tools
// keep the finite blocking round-trip these tests pin.

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// clientToolTestManager builds a manager with one session that has an ACTIVE
// run (requestID set and owned by the mock backend).
func clientToolTestManager(t *testing.T, key, runID string) (*Manager, *mockBackend) {
	t.Helper()
	mb := newMockBackend()
	mgr := NewManager(mb)
	s := newCliSession(key)
	s.requestID = runID
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{key: s}
	mgr.mu.Unlock()
	mb.StartRun(runID, types.RunOptions{})
	return mgr, mb
}

// wireClientToolsForTest runs the production two-step wiring — build the
// session-owned runtime onto RunOptions, then adapt it into the API
// RunConfig — exactly as prompt_dispatch.go does at the dispatch seam.
func wireClientToolsForTest(mgr *Manager, s *engineSession, key string, runCfg *backend.RunConfig) types.RunOptions {
	opts := types.RunOptions{PlanMode: s.planMode}
	mgr.buildClientToolRuntime(s, key, &opts)
	mgr.wireClientTools(key, &opts, runCfg)
	return opts
}

// TestClientTool_StateSnapshotLifecycle pins the engine_client_tool_state
// contract end to end for a machine tool: registration emits a snapshot
// carrying the pending call's facts, and fulfillment emits the authoritative
// EMPTY (non-nil) snapshot that clears client state.
func TestClientTool_StateSnapshotLifecycle(t *testing.T) {
	key, runID := "ct-state", "run-state"
	mgr, _ := clientToolTestManager(t, key, runID)
	s := mgr.sessions[key]
	s.config.ToolGate = &types.ToolGateConfig{
		Enabled:             true,
		ClientTools:         []types.ClientToolDef{{Name: "BenchMemberFile"}},
		ClientToolTimeoutMs: 1000,
	}

	// OnEvent is single-slot (a second registration replaces the first), so
	// one callback both collects events and plays the answering client.
	ec := &eventCollector{}
	mgr.OnEvent(func(emittedKey string, ev types.EngineEvent) {
		ec.mu.Lock()
		ec.events = append(ec.events, keyedEvent{key: emittedKey, event: ev})
		ec.mu.Unlock()
		if emittedKey != key || ev.Type != "engine_tool_gate_request" {
			return
		}
		go func(reqID string) {
			time.Sleep(5 * time.Millisecond)
			mgr.HandleToolGateResponse(key, reqID, "", "", "answered", false, nil)
		}(ev.GateRequestID)
	})

	var runCfg backend.RunConfig
	wireClientToolsForTest(mgr, s, key, &runCfg)
	result, err := runCfg.McpToolRouter(context.Background(), "BenchMemberFile", map[string]interface{}{"file": "x"})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("fulfillment failed: %+v", result)
	}

	snapshots := ec.byType("engine_client_tool_state")
	if len(snapshots) < 2 {
		t.Fatalf("want >=2 snapshots (register, clear), got %d", len(snapshots))
	}

	first := snapshots[0].event.ClientToolCalls
	if len(first) != 1 {
		t.Fatalf("register snapshot: want 1 pending call, got %d", len(first))
	}
	call := first[0]
	if call.ToolName != "BenchMemberFile" || call.RunID != runID {
		t.Errorf("pending call facts wrong: %+v", call)
	}
	if call.RequestID == "" || call.StartedAt == 0 {
		t.Errorf("pending call must carry requestId and startedAt: %+v", call)
	}
	if call.ToolInput["file"] != "x" {
		t.Errorf("pending call must carry the tool input, got %+v", call.ToolInput)
	}

	last := snapshots[len(snapshots)-1].event.ClientToolCalls
	if last == nil {
		t.Fatal("clear snapshot must be a non-nil empty slice ([] on the wire), got nil")
	}
	if len(last) != 0 {
		t.Errorf("clear snapshot: want 0 pending calls, got %d", len(last))
	}
}

// TestReconcileState_ReplaysClientToolSnapshot pins the reconnect contract:
// ReconcileState re-emits the pending client-tool snapshot (here: the
// authoritative empty one) so a re-attaching client can replace stale state.
func TestReconcileState_ReplaysClientToolSnapshot(t *testing.T) {
	key := "ct-reconcile"
	mgr := gateTestManager(t, key)
	ec := newEventCollector(mgr)

	mgr.ReconcileState(key)

	snapshots := ec.byType("engine_client_tool_state")
	if len(snapshots) != 1 {
		t.Fatalf("want exactly 1 replayed snapshot, got %d", len(snapshots))
	}
	if snapshots[0].event.ClientToolCalls == nil {
		t.Error("replayed snapshot must be non-nil so it serializes as []")
	}
}

// TestClientTool_CancellationClearsState pins the abandonment path: a
// cancelled tool context deregisters the pending call and emits the clear
// snapshot — a client must never be left rendering state for a call the
// engine already walked away from.
func TestClientTool_CancellationClearsState(t *testing.T) {
	key, runID := "ct-cancel", "run-cancel"
	mgr, _ := clientToolTestManager(t, key, runID)
	s := mgr.sessions[key]
	s.config.ToolGate = &types.ToolGateConfig{
		Enabled:             true,
		ClientTools:         []types.ClientToolDef{{Name: "BenchMemberFile"}},
		ClientToolTimeoutMs: 60000,
	}

	ec := newEventCollector(mgr)
	var runCfg backend.RunConfig
	wireClientToolsForTest(mgr, s, key, &runCfg)

	toolCtx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	result, err := runCfg.McpToolRouter(toolCtx, "BenchMemberFile", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || !result.IsError || !strings.Contains(result.Content, "cancelled") {
		t.Errorf("cancellation must produce a cancelled tool error, got %+v", result)
	}

	snapshots := ec.byType("engine_client_tool_state")
	if len(snapshots) < 2 {
		t.Fatalf("want register + clear snapshots, got %d", len(snapshots))
	}
	last := snapshots[len(snapshots)-1].event.ClientToolCalls
	if last == nil || len(last) != 0 {
		t.Errorf("cancellation must clear pending state, got %+v", last)
	}
}

// TestWireClientTools_HumanWaitJoinsToolListButParks pins the park wiring: a
// human-wait declaration joins ExternalTools (the model must be able to call
// it) and lands in RunConfig.HumanWaitClientTools (the runloop parks on it),
// and its name is deliberately NOT routed through the blocking wire
// round-trip — the runloop intercepts before any router call.
func TestWireClientTools_HumanWaitJoinsToolListButParks(t *testing.T) {
	key, runID := "ct-hw-wiring", "run-hw-wiring"
	mgr, _ := clientToolTestManager(t, key, runID)
	s := mgr.sessions[key]
	s.config.ToolGate = &types.ToolGateConfig{
		Enabled: true,
		ClientTools: []types.ClientToolDef{
			{Name: "AskUserQuestions", HumanWait: true, PlanModeSafe: true},
			{Name: "BenchMemberFile"},
		},
	}

	var runCfg backend.RunConfig
	wireClientToolsForTest(mgr, s, key, &runCfg)

	names := make([]string, 0, len(runCfg.ExternalTools))
	for _, td := range runCfg.ExternalTools {
		names = append(names, td.Name)
	}
	if len(names) != 2 {
		t.Fatalf("both tools must join ExternalTools, got %v", names)
	}
	if !runCfg.HumanWaitClientTools["AskUserQuestions"] {
		t.Error("human-wait tool must be named in RunConfig.HumanWaitClientTools")
	}
	if runCfg.HumanWaitClientTools["BenchMemberFile"] {
		t.Error("machine tool must NOT be in HumanWaitClientTools")
	}
}

// TestStartSession_ReplacesToolGateDeclaration pins the idempotent-restart
// contract: a second start_session for the same key adopts the caller's
// LATEST tool-gate declaration (including clearing it with nil), so a
// reconnecting or upgraded desktop re-asserts its client-tool set without
// tearing the session down. Runs capture their runtime at dispatch, so this
// never mutates an in-flight run.
func TestStartSession_ReplacesToolGateDeclaration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(newMockBackend())
	const key = "toolgate-replace"

	cfg := defaultConfig()
	cfg.ToolGate = &types.ToolGateConfig{
		Enabled:     true,
		ClientTools: []types.ClientToolDef{{Name: "OldTool"}},
	}
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Re-assert with a NEW declaration (the reconnect/upgrade path).
	cfg2 := defaultConfig()
	cfg2.ToolGate = &types.ToolGateConfig{
		Enabled: true,
		ClientTools: []types.ClientToolDef{
			{Name: "AskUserQuestions", HumanWait: true},
			{Name: "NewTool"},
		},
	}
	res, err := mgr.StartSession(key, cfg2)
	if err != nil {
		t.Fatalf("StartSession (idempotent): %v", err)
	}
	if !res.Existed {
		t.Fatal("second StartSession must hit the idempotent branch")
	}

	mgr.mu.RLock()
	got := mgr.sessions[key].config.ToolGate
	mgr.mu.RUnlock()
	if got == nil || len(got.ClientTools) != 2 || got.ClientTools[0].Name != "AskUserQuestions" {
		t.Fatalf("tool-gate declaration not replaced: %+v", got)
	}

	// Clearing: a nil ToolGate on a later start_session removes the gating.
	cfg3 := defaultConfig()
	if _, err := mgr.StartSession(key, cfg3); err != nil {
		t.Fatalf("StartSession (clear): %v", err)
	}
	mgr.mu.RLock()
	cleared := mgr.sessions[key].config.ToolGate
	mgr.mu.RUnlock()
	if cleared != nil {
		t.Fatalf("nil ToolGate must clear the prior declaration, got %+v", cleared)
	}
}

// TestStatusFields_PendingClientToolIsPendingWork pins the HasPendingWork
// inclusion: an open machine client-tool call is accepted work, so a status
// snapshot must not read as terminal while one is pending.
func TestStatusFields_PendingClientToolIsPendingWork(t *testing.T) {
	key := "ct-pending-work"
	mgr := gateTestManager(t, key)

	fields, ok := mgr.buildStatusFields(key)
	if !ok || fields.HasPendingWork {
		t.Fatalf("baseline: want HasPendingWork=false, got %+v (ok=%v)", fields, ok)
	}

	mgr.mu.Lock()
	mgr.sessions[key].pendingClientToolCalls = map[string]types.ClientToolCallState{
		"req-1": {RequestID: "req-1", ToolName: "BenchMemberFile"},
	}
	mgr.mu.Unlock()

	fields, ok = mgr.buildStatusFields(key)
	if !ok || !fields.HasPendingWork {
		t.Fatalf("pending client tool: want HasPendingWork=true, got %+v (ok=%v)", fields, ok)
	}
}
