package agents

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestRegistry_HandleRoundTrip(t *testing.T) {
	r := NewRegistry()
	r.RegisterHandle("worker-1", types.AgentHandle{PID: 42})
	h, ok := r.LookupHandle("worker-1")
	if !ok {
		t.Fatal("expected handle")
	}
	if h.PID != 42 {
		t.Errorf("expected PID=42, got %d", h.PID)
	}
}

func TestRegistry_DeregisterHandle(t *testing.T) {
	r := NewRegistry()
	r.RegisterHandle("x", types.AgentHandle{PID: 1})
	r.DeregisterHandle("x")
	if _, ok := r.LookupHandle("x"); ok {
		t.Error("expected handle removed")
	}
}

func TestRegistry_AllHandles(t *testing.T) {
	r := NewRegistry()
	r.RegisterHandle("a", types.AgentHandle{PID: 1})
	r.RegisterHandle("b", types.AgentHandle{PID: 2})
	all := r.AllHandles()
	if len(all) != 2 {
		t.Fatalf("expected 2, got %d", len(all))
	}
}

func TestRegistry_ClearHandles(t *testing.T) {
	r := NewRegistry()
	r.RegisterHandle("a", types.AgentHandle{PID: 1})
	r.RegisterHandle("b", types.AgentHandle{PID: 2})
	pids, names := r.ClearHandles()
	if len(pids) != 2 || len(names) != 2 {
		t.Fatalf("expected 2 pids/names, got %d/%d", len(pids), len(names))
	}
	if r.HandleCount() != 0 {
		t.Error("expected 0 handles after clear")
	}
}

func TestRegistry_SpecRoundTrip(t *testing.T) {
	r := NewRegistry()
	r.RegisterSpec(types.AgentSpec{Name: "planner", Description: "Plans"})
	spec, ok := r.LookupSpec("planner")
	if !ok {
		t.Fatal("expected spec")
	}
	if spec.Description != "Plans" {
		t.Errorf("expected 'Plans', got %q", spec.Description)
	}
}

func TestRegistry_RegisterSpecEmptyNameNoop(t *testing.T) {
	r := NewRegistry()
	r.RegisterSpec(types.AgentSpec{Name: "", Description: "skip"})
	if len(r.AllSpecNames()) != 0 {
		t.Error("expected no specs for empty name")
	}
}

func TestRegistry_DeregisterSpec(t *testing.T) {
	r := NewRegistry()
	r.RegisterSpec(types.AgentSpec{Name: "x", Description: "Y"})
	r.DeregisterSpec("x")
	if _, ok := r.LookupSpec("x"); ok {
		t.Error("expected spec removed")
	}
}

func TestRegistry_AllSpecNames(t *testing.T) {
	r := NewRegistry()
	r.RegisterSpec(types.AgentSpec{Name: "a"})
	r.RegisterSpec(types.AgentSpec{Name: "b"})
	names := r.AllSpecNames()
	if len(names) != 2 {
		t.Fatalf("expected 2, got %d", len(names))
	}
}

func TestRegistry_StateAppendAndMerge(t *testing.T) {
	r := NewRegistry()
	r.CacheExtStates([]types.AgentStateUpdate{{Name: "ext-1", Status: "running"}})
	r.AppendState(types.AgentStateUpdate{Name: "agent-1", Status: "running"})

	merged := r.MergedSnapshot()
	if len(merged) != 2 {
		t.Fatalf("expected 2 merged, got %d", len(merged))
	}
	if merged[0].Name != "ext-1" || merged[1].Name != "agent-1" {
		t.Errorf("unexpected merge order: %v", merged)
	}
}

func TestRegistry_UpdateState(t *testing.T) {
	r := NewRegistry()
	r.AppendState(types.AgentStateUpdate{Name: "a", Status: "running"})
	r.UpdateState("a", func(s *types.AgentStateUpdate) {
		s.Status = "done"
	})
	merged := r.MergedSnapshot()
	if len(merged) != 1 || merged[0].Status != "done" {
		t.Errorf("expected done, got %v", merged)
	}
}

func TestRegistry_ClearStates(t *testing.T) {
	r := NewRegistry()
	r.AppendState(types.AgentStateUpdate{Name: "a", Status: "running"})
	r.ClearStates()
	if len(r.MergedSnapshot()) != 0 {
		t.Error("expected empty after clear")
	}
}

// TestRegistry_NoStaleRunningAfterTerminalUpdate covers the engine
// invariant from docs/architecture/agent-state.md: every termination
// path must transition the state to a terminal status (done/error/
// cancelled) before the next snapshot is read. After UpdateState with
// any terminal status, MergedSnapshot must not report the agent as
// "running".
func TestRegistry_NoStaleRunningAfterTerminalUpdate(t *testing.T) {
	terminalStatuses := []string{"done", "error", "cancelled"}
	for _, terminal := range terminalStatuses {
		t.Run(terminal, func(t *testing.T) {
			r := NewRegistry()
			r.AppendState(types.AgentStateUpdate{Name: "a", Status: "running"})
			r.UpdateState("a", func(s *types.AgentStateUpdate) {
				s.Status = terminal
			})
			merged := r.MergedSnapshot()
			if len(merged) != 1 {
				t.Fatalf("expected 1 merged, got %d", len(merged))
			}
			if merged[0].Status == "running" {
				t.Errorf("expected non-running terminal status, got %q", merged[0].Status)
			}
			if merged[0].Status != terminal {
				t.Errorf("expected status %q, got %q", terminal, merged[0].Status)
			}
		})
	}
}

// TestRegistry_CacheExtStatesNilDrops mirrors the host-death recovery
// behavior in handleHostDeath: when an extension dies the engine drops
// its cached extension states by passing nil. The subsequent snapshot
// must contain only engine-managed states (or nothing).
func TestRegistry_CacheExtStatesNilDrops(t *testing.T) {
	r := NewRegistry()
	r.CacheExtStates([]types.AgentStateUpdate{
		{Name: "ext-a", Status: "running"},
		{Name: "ext-b", Status: "running"},
	})
	if len(r.MergedSnapshot()) != 2 {
		t.Fatalf("setup expected 2, got %d", len(r.MergedSnapshot()))
	}

	r.CacheExtStates(nil)
	merged := r.MergedSnapshot()
	if len(merged) != 0 {
		t.Errorf("expected empty after CacheExtStates(nil), got %d entries: %v", len(merged), merged)
	}
}

// TestRegistry_CacheExtStatesNilPreservesEngineStates ensures dropping
// the extension cache does not also wipe engine-managed states. The
// host-death recovery only clears the extension's authority; engine-
// managed sub-agents from the Agent tool are still live.
func TestRegistry_CacheExtStatesNilPreservesEngineStates(t *testing.T) {
	r := NewRegistry()
	r.CacheExtStates([]types.AgentStateUpdate{{Name: "ext-1", Status: "running"}})
	r.AppendState(types.AgentStateUpdate{Name: "engine-1", Status: "running"})

	r.CacheExtStates(nil)

	merged := r.MergedSnapshot()
	if len(merged) != 1 {
		t.Fatalf("expected only engine-managed state, got %d entries", len(merged))
	}
	if merged[0].Name != "engine-1" {
		t.Errorf("expected engine-1, got %q", merged[0].Name)
	}
}

func TestRegistry_IsDescendant(t *testing.T) {
	r := NewRegistry()
	r.RegisterHandle("root", types.AgentHandle{PID: 1})
	r.RegisterHandle("child", types.AgentHandle{PID: 2, ParentAgent: "root"})
	r.RegisterHandle("grandchild", types.AgentHandle{PID: 3, ParentAgent: "child"})

	if !r.IsDescendant("child", "root") {
		t.Error("child should be descendant of root")
	}
	if !r.IsDescendant("grandchild", "root") {
		t.Error("grandchild should be descendant of root")
	}
	if r.IsDescendant("root", "child") {
		t.Error("root should not be descendant of child")
	}
}

func TestRegistry_ConcurrentAccess(t *testing.T) {
	r := NewRegistry()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			r.RegisterHandle("h", types.AgentHandle{PID: idx})
			r.LookupHandle("h")
			r.RegisterSpec(types.AgentSpec{Name: "s"})
			r.LookupSpec("s")
			r.AppendState(types.AgentStateUpdate{Name: "x"})
			r.MergedSnapshot()
		}(i)
	}
	wg.Wait()
}
