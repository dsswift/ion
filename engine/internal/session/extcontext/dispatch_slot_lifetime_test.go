package extcontext

// Regressions for the two windows in which a dispatch's running agent-state
// slot is unprotected by ActiveIDs and can be swept by a concurrent run-exit
// clear while the agent is genuinely still live — the "agent stuck running"
// defect observed in conversation 1784164004725-737dda10cbf9, where the
// cloud-architect dispatch streamed for ~5 minutes after its slot was swept and
// every UpdateStateByID logged "no slot found (terminal update landed nowhere)".
//
// The invariant these tests pin: a running agent-state slot must be covered by
// an ActiveIDs entry for its ENTIRE running lifetime.
//
//   - Birth gap: the slot is created/broadcast before registerDispatch runs.
//     Reserve() closes it by placing the id in ActiveIDs at slot-creation time.
//   - Death gap: the terminal transition must precede Deregister so the slot is
//     terminal (never swept) before it leaves ActiveIDs.
//   - Belt: UpsertStateByID re-materializes a terminal row if some future gap
//     ever leaves the slot swept, so the terminal state is never silently lost.
import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
)

// Birth gap, fixed: the slot is exposed as running before full registration;
// Reserve keeps its id in ActiveIDs so a concurrent sweep preserves the live
// slot and the later terminal update lands.
func TestDispatchSlotLifetime_ReserveCoversBirthGap(t *testing.T) {
	store := agents.NewRegistry()
	registry := NewDispatchRegistry()
	const id = "dispatch-cloud-architect-1-aaa"

	// Order mirrors dispatch_agent.go: Reserve, then expose the running slot.
	registry.Reserve(id, "cloud-architect", "", 1)
	store.AppendState(types.AgentStateUpdate{Name: "cloud-architect", ID: id, Status: "running"})

	// A concurrent run-exit sweep fires while the dispatch is still setting up
	// (before registerDispatch). Only the reservation protects the slot.
	store.ClearRunningStatesExceptIDsOrNames(registry.ActiveIDs(), map[string]bool{})

	if !rawHasID(store, id) {
		t.Fatalf("reserved dispatch slot %q was swept; Reserve must keep it in ActiveIDs across the birth gap", id)
	}

	landed := false
	store.UpdateStateByID(id, func(s *types.AgentStateUpdate) { s.Status = "done"; landed = true })
	if !landed {
		t.Fatal("terminal update landed nowhere despite the reservation")
	}
}

// Birth gap, revert-red: without the reservation, ActiveIDs is empty at the
// sweep and the live slot is destroyed — the exact production failure. This
// pins that the reservation (not some other retention) is what saves the slot.
func TestDispatchSlotLifetime_WithoutReserveBirthGapSweeps(t *testing.T) {
	store := agents.NewRegistry()
	registry := NewDispatchRegistry()
	const id = "dispatch-cloud-architect-1-aaa"

	store.AppendState(types.AgentStateUpdate{Name: "cloud-architect", ID: id, Status: "running"})
	store.ClearRunningStatesExceptIDsOrNames(registry.ActiveIDs(), map[string]bool{})

	if rawHasID(store, id) {
		t.Fatalf("slot %q unexpectedly survived with empty ActiveIDs; the birth-gap failure requires it to be swept", id)
	}
	landed := false
	store.UpdateStateByID(id, func(s *types.AgentStateUpdate) { landed = true })
	if landed {
		t.Fatal("terminal update landed on a slot that should have been swept")
	}
}

// RegisterWithID upgrades a reservation in place: the id stays live with no
// duplicate entry, and the upgrade is counted as a real registration.
func TestDispatchSlotLifetime_RegisterUpgradesReservation(t *testing.T) {
	registry := NewDispatchRegistry()
	const id = "dispatch-x-1-aaa"

	registry.Reserve(id, "x", "", 1)
	if !registry.ActiveIDs()[id] {
		t.Fatal("reserved id is not active")
	}

	registry.RegisterWithID(id, "x", func() {}, backend.NewApiBackend(), "sess", "", 1)

	ids := registry.ActiveIDs()
	if len(ids) != 1 || !ids[id] {
		t.Fatalf("after upgrade ActiveIDs = %v, want exactly {%q}", ids, id)
	}
	if got := registry.TotalRegistrations(); got != 1 {
		t.Fatalf("TotalRegistrations = %d after upgrade, want 1", got)
	}
}

// Death gap, fixed: marking the slot terminal BEFORE Deregister makes it a
// terminal row, which the run-exit clear never sweeps — so deregister-then-
// sweep cannot orphan it.
func TestDispatchSlotLifetime_TerminalBeforeDeregisterSurvivesSweep(t *testing.T) {
	store := agents.NewRegistry()
	registry := NewDispatchRegistry()
	const id = "dispatch-x-1-aaa"

	registry.RegisterWithID(id, "x", func() {}, backend.NewApiBackend(), "sess", "", 1)
	store.AppendState(types.AgentStateUpdate{Name: "x", ID: id, Status: "running"})

	// New order: terminal transition while still registered, then deregister.
	store.UpdateStateByID(id, func(s *types.AgentStateUpdate) { s.Status = "done" })
	registry.Deregister(id)
	// A sweep after deregister: terminal slots are never swept.
	store.ClearRunningStatesExceptIDsOrNames(registry.ActiveIDs(), map[string]bool{})

	if got := rawStatusByID(store, id); got != "done" {
		t.Fatalf("terminal slot lost after deregister+sweep, status = %q, want \"done\"", got)
	}
}

// Death gap, belt: if the old order ran (Deregister, then a sweep, then the
// terminal update), UpdateStateByID loses the terminal state. UpsertStateByID
// re-materializes the terminal row so the agent is never stranded as running.
func TestDispatchSlotLifetime_UpsertReMaterializesSweptTerminal(t *testing.T) {
	store := agents.NewRegistry()
	registry := NewDispatchRegistry()
	const id = "dispatch-x-1-aaa"

	registry.RegisterWithID(id, "x", func() {}, backend.NewApiBackend(), "sess", "", 1)
	store.AppendState(types.AgentStateUpdate{Name: "x", ID: id, Status: "running"})

	// Reproduce the death-gap window: deregister, then a sweep fires before the
	// terminal update.
	registry.Deregister(id)
	store.ClearRunningStatesExceptIDsOrNames(registry.ActiveIDs(), map[string]bool{})
	if rawHasID(store, id) {
		t.Fatal("precondition: the running slot must be swept in the old-order window")
	}

	// Plain UpdateStateByID would silently drop the terminal state.
	landed := false
	store.UpdateStateByID(id, func(s *types.AgentStateUpdate) { landed = true })
	if landed {
		t.Fatal("UpdateStateByID unexpectedly landed on a swept slot")
	}

	// The Upsert belt re-materializes the terminal row.
	seed := types.AgentStateUpdate{Name: "x", ID: id, Status: "running", Metadata: map[string]interface{}{}}
	store.UpsertStateByID(id, seed, func(s *types.AgentStateUpdate) { s.Status = "done" })
	if got := rawStatusByID(store, id); got != "done" {
		t.Fatalf("Upsert belt failed to re-materialize the terminal row, status = %q, want \"done\"", got)
	}
}
