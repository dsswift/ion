package extcontext

// TestNestedDispatchRetention_Depth2SlotSurvivesAndTerminalUpdateLands is the
// end-to-end regression for the nested-dispatch "agent stuck running" defect.
//
// Defect (observed in conversation 1782699086966-a04524cbffe4): a dev-lead
// (depth 1) dispatched engine-dev (depth 2) via the Agent tool. engine-dev's
// agent-state slot was appended ID-keyed into the orchestrator's single flat
// store, but the run-exit retention preserved running slots BY NAME
// (ActiveNames + ClearRunningStatesExcept). When the depth-2 name was not a
// live dispatch NAME at the clear instant, its still-running slot was swept;
// every later UpdateStateByID(depth2ID) — including the terminal "done" — then
// found no slot and was dropped. The engine logged
//   "UpdateStateByID: no slot found for id=... (terminal update landed nowhere,
//    agent may appear stuck as running)"
// and the dev-lead's Agent-tool row rendered as perpetually running.
//
// The decisive difference between name-keyed and ID-keyed retention surfaces
// when a running depth-2 slot's NAME is absent from the live-dispatch name set
// while its unique dispatch ID is still live. This test reproduces that exact
// condition and asserts ID-keyed retention preserves the slot so its terminal
// update lands.
//
// Revert-red: switching the retention call to name-keyed
// ClearRunningStatesExcept(activeNames) sweeps the depth-2 slot (its name is
// not in activeNames), the terminal update lands nowhere, and the survival
// assertion fails.
import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestNestedDispatchRetention_Depth2SlotSurvivesAndTerminalUpdateLands(t *testing.T) {
	store := agents.NewRegistry()
	registry := NewDispatchRegistry()

	const sessionKey = "session-root"

	// Depth-1 dev-lead: live dispatch + running agent-state slot. This is the
	// only entry whose NAME is in the live-dispatch name set.
	depth1ID := "dispatch-dev-lead-111-aaa"
	registry.RegisterWithID(depth1ID, "dev-lead", func() {}, backend.NewApiBackend(), sessionKey, "", 1)
	store.AppendState(types.AgentStateUpdate{Name: "dev-lead", ID: depth1ID, Status: "running"})

	// Depth-2 engine-dev: live dispatch (registered, so its ID is in
	// ActiveIDs) + running agent-state slot. Its NAME "engine-dev" is NOT the
	// depth-1 name; in the production race the run-exit clear can fire while the
	// depth-2 name is absent from the live keep-set the consumer built. We model
	// that by building the name keep-set from the depth-1 dispatch only (below),
	// the exact pre-fix failure surface.
	depth2ID := "dispatch-engine-dev-222-bbb"
	registry.RegisterWithID(depth2ID, "engine-dev", func() {}, backend.NewApiBackend(), sessionKey, depth1ID, 2)
	store.AppendState(types.AgentStateUpdate{Name: "engine-dev", ID: depth2ID, Status: "running"})

	// Run the exact retention handleRunExit performs (event_translation.go):
	// preserve running slots whose ID is live OR whose name is live. To prove
	// the ID branch is what saves the depth-2 slot (not the name branch), build
	// the name keep-set WITHOUT the depth-2 name — the faithful production race
	// where the depth-2 name is absent from the live name set at the clear
	// instant. The depth-2 dispatch ID is still live, so ID-keyed retention must
	// preserve the slot.
	activeIDs := registry.ActiveIDs()
	activeNames := map[string]bool{"dev-lead": true} // depth-2 name deliberately absent
	store.ClearRunningStatesExceptIDsOrNames(activeIDs, activeNames)

	// (1) The depth-2 slot must survive the clear.
	if !rawHasID(store, depth2ID) {
		t.Fatalf("depth-2 slot %q was swept by run-exit retention; it must survive while its dispatch is live", depth2ID)
	}

	// (2) The terminal update for the depth-2 dispatch must land on a real slot.
	// Deregister the dispatch first (the child finished), then apply the
	// terminal transition — this mirrors runChild's deregister + terminal
	// UpdateAgentStateByID ordering (dispatch_agent.go).
	registry.Deregister(depth2ID)
	landed := false
	store.UpdateStateByID(depth2ID, func(s *types.AgentStateUpdate) {
		s.Status = "done"
		landed = true
	})
	if !landed {
		t.Fatalf("terminal UpdateStateByID(%q) landed nowhere — slot was missing (the 'agent stuck running' defect)", depth2ID)
	}
	if got := rawStatusByID(store, depth2ID); got != "done" {
		t.Errorf("depth-2 slot status = %q after terminal update, want \"done\"", got)
	}
}

// TestNestedDispatchRetention_IDKeyPreservesWhenNameAbsent isolates the precise
// behavioral difference: a running depth-2 slot whose NAME is not in the
// preserve-by-name set is swept by name-keyed retention but preserved by
// ID-keyed retention. Both directions are asserted so the contrast is pinned.
func TestNestedDispatchRetention_IDKeyPreservesWhenNameAbsent(t *testing.T) {
	depth2ID := "dispatch-engine-dev-222-bbb"

	// Name-keyed retention (pre-fix): "engine-dev" not in the keep-set -> swept.
	nameStore := agents.NewRegistry()
	nameStore.AppendState(types.AgentStateUpdate{Name: "engine-dev", ID: depth2ID, Status: "running"})
	nameStore.ClearRunningStatesExcept(map[string]bool{"dev-lead": true})
	if rawHasID(nameStore, depth2ID) {
		t.Fatalf("name-keyed retention unexpectedly kept depth-2 slot %q; pre-fix it must sweep it", depth2ID)
	}
	landed := false
	nameStore.UpdateStateByID(depth2ID, func(s *types.AgentStateUpdate) { landed = true })
	if landed {
		t.Error("terminal update landed under name-keyed retention; the slot should have been orphaned")
	}

	// ID-keyed retention (fix): same name absent from keep-set, but the live
	// dispatch ID preserves the slot.
	idStore := agents.NewRegistry()
	idStore.AppendState(types.AgentStateUpdate{Name: "engine-dev", ID: depth2ID, Status: "running"})
	idStore.ClearRunningStatesExceptIDsOrNames(
		map[string]bool{depth2ID: true},   // ID live
		map[string]bool{"dev-lead": true}, // name absent
	)
	if !rawHasID(idStore, depth2ID) {
		t.Fatalf("ID-keyed retention swept depth-2 slot %q despite live ID; the fix must preserve it", depth2ID)
	}
	landed = false
	idStore.UpdateStateByID(depth2ID, func(s *types.AgentStateUpdate) {
		s.Status = "done"
		landed = true
	})
	if !landed {
		t.Fatal("terminal update landed nowhere under ID-keyed retention; the slot must have survived")
	}
}

// rawHasID reports whether the store holds a slot with the given ID.
func rawHasID(r *agents.Registry, id string) bool {
	for _, s := range r.MergedSnapshot() {
		if s.ID == id {
			return true
		}
	}
	return false
}

// rawStatusByID returns the status of the slot with the given ID, or "" if
// absent.
func rawStatusByID(r *agents.Registry, id string) string {
	for _, s := range r.MergedSnapshot() {
		if s.ID == id {
			return s.Status
		}
	}
	return ""
}
