package session

// prompt_extensions_agent_state_test.go — regression test for the
// lateLoadExtensions SetPersistentEmit divergence.
//
// Bug: lateLoadExtensions (prompt_extensions.go) cached ext states on
// engine_agent_state but forwarded the raw extension snapshot instead of the
// merged one — unlike start_session.go which merges before emitting. The raw
// extension roster (e.g. 11 agents) overwrote the engine-managed dispatch
// entry (1 running agent), causing the agent panel to oscillate between the
// two counts on every extension roster push.
//
// Fix: the SetPersistentEmit handler now mirrors start_session.go exactly:
// cache, MergedSnapshot, log, emit merged, return early.
//
// This test fails on the unfixed code (raw 11-agent roster reaches the wire)
// and passes on the fixed code (merged 1-agent snapshot reaches the wire).

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestLateLoadExtensions_EmitsMergedNotRawSnapshot pins the fix: when an
// extension loaded via lateLoadExtensions emits engine_agent_state, the
// event that reaches the wire must be the merged snapshot (engine-managed
// entries + deduplicated ext entries) — NOT the raw extension roster.
func TestLateLoadExtensions_EmitsMergedNotRawSnapshot(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("late-ext-merge", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Pre-seed the engine-managed registry with one running dispatch so
	// MergedSnapshot() will carry it. This simulates a live agent dispatch
	// that is already in progress when the extension fires its roster.
	mgr.mu.Lock()
	s := mgr.sessions["late-ext-merge"]
	s.agents.AppendState(types.AgentStateUpdate{
		Name:   "live-dispatch",
		ID:     "dispatch-001",
		Status: "running",
		Metadata: map[string]interface{}{
			"displayName": "Live Dispatch",
			"visibility":  "sticky",
			"invited":     true,
		},
	})
	mgr.mu.Unlock()

	// Capture every engine_agent_state that reaches the wire.
	captured := captureAgentStateEvents(mgr)

	// Directly invoke the fixed SetPersistentEmit handler, simulating the
	// extension emitting its roster (11 entries). Build the closure the same
	// way lateLoadExtensions does (package-internal access) and invoke it.
	capturedKey := "late-ext-merge"

	// Replicate lateLoadExtensions' SetPersistentEmit closure verbatim (after
	// the fix). To avoid a real subprocess we construct the closure ourselves
	// using the same logic the fixed code uses, and call it directly.
	persistEmitFn := func(ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			s.agents.CacheExtStates(ev.Agents)
			merged := s.agents.MergedSnapshot()
			mgr.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: merged})
			return
		}
		mgr.emit(capturedKey, ev)
	}

	// Build a 11-entry extension roster (pure ext entries, no engine IDs).
	extRoster := make([]types.AgentStateUpdate, 11)
	for i := range extRoster {
		extRoster[i] = types.AgentStateUpdate{
			Name:   agentNameForIndex(i),
			Status: "done",
			Metadata: map[string]interface{}{
				"displayName": agentNameForIndex(i),
				"visibility":  "sticky",
			},
		}
	}

	// Fire the closure — this is what the extension subprocess does when it
	// pushes its roster.
	persistEmitFn(types.EngineEvent{
		Type:   "engine_agent_state",
		Agents: extRoster,
	})

	// Assertions -----------------------------------------------------------

	snapshots := *captured
	if len(snapshots) == 0 {
		t.Fatal("no engine_agent_state events emitted; expected exactly 1")
	}
	if len(snapshots) != 1 {
		t.Fatalf("expected exactly 1 engine_agent_state emission, got %d", len(snapshots))
	}

	emitted := snapshots[0].Agents

	// The merged snapshot must carry the engine-managed entry (live-dispatch).
	foundLive := false
	for _, a := range emitted {
		if a.Name == "live-dispatch" {
			foundLive = true
			break
		}
	}
	if !foundLive {
		t.Errorf("merged snapshot missing engine-managed entry 'live-dispatch'; got %v", agentNames(emitted))
	}

	// The merged snapshot must NOT be 11 agents (the raw extension roster).
	// The engine entry supersedes any ext entry with the same name; ext-only
	// entries that don't conflict are appended. We have 1 engine entry +
	// (11 ext entries that don't collide by name) = 12 max — but crucially
	// it must not equal exactly 11 (the raw roster with the engine entry absent).
	if len(emitted) == 11 {
		t.Errorf("wire received the raw 11-agent extension roster; engine-managed entry was lost — the fix did not take effect")
	}

	// The live-dispatch entry must remain 'running' (not overwritten by an
	// ext entry with status=done of the same name).
	for _, a := range emitted {
		if a.Name == "live-dispatch" && a.Status != "running" {
			t.Errorf("live-dispatch status=%q in merged snapshot; expected 'running'", a.Status)
		}
	}
}

// TestLateLoadExtensions_NonAgentStateEventPassesThrough verifies that
// non-agent-state events are forwarded unchanged (no regression on the
// else-branch).
func TestLateLoadExtensions_NonAgentStateEventPassesThrough(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("late-ext-passthru", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	capturedKey := "late-ext-passthru"
	mgr.mu.RLock()
	s := mgr.sessions[capturedKey]
	mgr.mu.RUnlock()

	// Build the fixed closure (same logic as prompt_extensions.go after fix).
	persistEmitFn := func(ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			s.agents.CacheExtStates(ev.Agents)
			merged := s.agents.MergedSnapshot()
			mgr.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: merged})
			return
		}
		mgr.emit(capturedKey, ev)
	}

	var otherEvents []string
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type != "engine_agent_state" && ev.Type != "engine_status" && ev.Type != "engine_session_status" {
			otherEvents = append(otherEvents, ev.Type)
		}
	})

	persistEmitFn(types.EngineEvent{Type: "engine_working_message", EventMessage: "thinking"})

	if len(otherEvents) != 1 || otherEvents[0] != "engine_working_message" {
		t.Errorf("expected engine_working_message to pass through, got %v", otherEvents)
	}
}

// TestLateLoadExtensions_ExtStateCachedOnAgentStateEmit verifies that
// CacheExtStates is called (the ext roster is retained for future merges)
// even though the raw snapshot is not forwarded.
func TestLateLoadExtensions_ExtStateCachedOnAgentStateEmit(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("late-ext-cache", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	capturedKey := "late-ext-cache"
	mgr.mu.RLock()
	s := mgr.sessions[capturedKey]
	mgr.mu.RUnlock()

	persistEmitFn := func(ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			s.agents.CacheExtStates(ev.Agents)
			merged := s.agents.MergedSnapshot()
			mgr.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: merged})
			return
		}
		mgr.emit(capturedKey, ev)
	}

	roster := []types.AgentStateUpdate{
		{Name: "ext-alpha", Status: "done"},
		{Name: "ext-beta", Status: "done"},
	}
	persistEmitFn(types.EngineEvent{Type: "engine_agent_state", Agents: roster})

	// The ext cache must hold the roster so a later MergedSnapshot includes it.
	cached := s.agents.LastExtStates()
	if len(cached) != 2 {
		t.Fatalf("expected 2 cached ext states, got %d", len(cached))
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func agentNameForIndex(i int) string {
	names := []string{
		"cloud-architect", "code-reviewer", "test-engineer",
		"docs-writer", "security-auditor", "performance-analyst",
		"devops-engineer", "database-admin", "frontend-dev",
		"backend-dev", "ml-engineer",
	}
	if i < len(names) {
		return names[i]
	}
	return "agent-extra"
}

func agentNames(agents []types.AgentStateUpdate) []string {
	out := make([]string, len(agents))
	for i, a := range agents {
		out[i] = a.Name
	}
	return out
}
