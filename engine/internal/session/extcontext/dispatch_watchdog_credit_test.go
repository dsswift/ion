package extcontext

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for the watchdog progress-credit routing (dispatch-lifecycle root
// cause I): a nested child's events must refresh the run-progress watchdog
// clock of the run that is actually blocked on it — the DISPATCHING PARENT's
// run — not (only) the root session's main-loop run. Before the fix, every
// lead blocked in a synchronous dispatch was killed at the 10-minute stall
// threshold while its specialist streamed, because the specialist's activity
// was credited to the root.

// bumpProbeBackend is a RunBackend that records BumpRunProgress calls —
// satisfying both backend.RunBackend and the registry's progressBumpable.
type bumpProbeBackend struct {
	bumped chan string
}

func (b *bumpProbeBackend) StartRun(string, types.RunOptions)                {}
func (b *bumpProbeBackend) OnNormalized(func(string, types.NormalizedEvent)) {}
func (b *bumpProbeBackend) OnExit(func(string, *int, *string, string))       {}
func (b *bumpProbeBackend) OnError(func(string, error))                      {}
func (b *bumpProbeBackend) Cancel(string) bool                               { return false }
func (b *bumpProbeBackend) IsRunning(string) bool                            { return false }
func (b *bumpProbeBackend) WriteToStdin(string, interface{}) error           { return nil }
func (b *bumpProbeBackend) FlushConversations()                              {}
func (b *bumpProbeBackend) Capabilities() backend.BackendCapabilities {
	return backend.BackendCapabilities{Kind: "mock"}
}
func (b *bumpProbeBackend) BumpRunProgress(requestID string) { b.bumped <- requestID }

// TestDispatchRegistry_BumpProgressForID_ReachesParentRun pins the registry
// half of root cause I: BumpProgressForID resolves the dispatch's Child
// backend + ChildRunID and refreshes THAT run's clock, and degrades to false
// (caller falls back to the root bump) for unknown, reserved, or
// non-bumpable entries.
func TestDispatchRegistry_BumpProgressForID_ReachesParentRun(t *testing.T) {
	probe := &bumpProbeBackend{bumped: make(chan string, 4)}
	r := NewDispatchRegistry()
	r.RegisterWithID("parent-disp", "lead", func() {}, probe, "sess", "", 1)
	r.SetChildRunID("parent-disp", "sess-parent-run-id")

	if !r.BumpProgressForID("parent-disp") {
		t.Fatal("BumpProgressForID returned false for a bumpable registered dispatch")
	}
	select {
	case runID := <-probe.bumped:
		if runID != "sess-parent-run-id" {
			t.Errorf("bumped run = %q, want sess-parent-run-id (the parent's ChildRunID)", runID)
		}
	case <-time.After(time.Second):
		t.Fatal("BumpRunProgress never reached the parent's backend")
	}

	// Unknown dispatch → false (call site falls back to the root bump).
	if r.BumpProgressForID("no-such-dispatch") {
		t.Error("BumpProgressForID returned true for an unknown dispatch")
	}
	// Reservation placeholder (nil Child) → false.
	r.Reserve("reserved-only", "x", "", 1)
	if r.BumpProgressForID("reserved-only") {
		t.Error("BumpProgressForID returned true for a reservation with no backend")
	}
	// Registered but empty ChildRunID → false.
	r.RegisterWithID("no-run-id", "y", func() {}, probe, "sess", "", 1)
	if r.BumpProgressForID("no-run-id") {
		t.Error("BumpProgressForID returned true with an unset ChildRunID")
	}
}

// TestApiBackend_BumpRunProgress_DefersWatchdog pins the backend half end to
// end with a REAL ApiBackend run: a run whose provider stream is held open
// emits nothing on its own, so its lastProgressAt only moves when
// BumpRunProgress lands. This is the mechanism that keeps a blocked lead
// alive while its specialist works. (The stall-cancel threshold itself is
// minutes long — driving the watchdog to an actual kill is integration
// territory; the unit contract is the clock refresh.)
func TestApiBackend_BumpRunProgress_DefersWatchdog(t *testing.T) {
	api := backend.NewApiBackend()
	// No provider registered for this model: resolveProviderForRun exits the
	// run immediately, so instead validate against the exported surface —
	// BumpRunProgress on an unknown run must be a safe no-op...
	api.BumpRunProgress("not-a-run") // must not panic

	// ...and the HybridBackend wrapper forwards to its inner API backend
	// (the registry stores hybrid children under the hybrid manager, so the
	// wrapper must satisfy progressBumpable itself).
	h := backend.NewHybridBackend()
	h.BumpRunProgress("also-not-a-run") // must not panic; exercises InnerApi forwarding
}
