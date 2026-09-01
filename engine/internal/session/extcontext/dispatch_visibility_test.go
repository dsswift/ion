package extcontext

import "testing"

// Default roster visibility for a dispatch is STICKY.
//
// The prior effective default was ephemeral: any agent row whose metadata
// omitted the field was dropped from a client roster the instant its run
// stopped. A dispatched child was therefore gone from its parent's drill-down
// before an operator could open it, so a completed dispatch always looked as
// though it had dispatched nothing.
//
// Observed live: a poll-check child appeared in seven consecutive agent-state
// snapshots, every one `status=running`, correctly attributed to its parent --
// and no snapshot after the dispatch completed carried it at all.
//
// Persisting the row is the useful behavior and vanishing is the special case,
// so vanishing is what a caller opts into.
func TestDispatchVisibilityDefaultsToSticky(t *testing.T) {
	if got := resolveDispatchVisibility("", "agent-1"); got != VisibilitySticky {
		t.Fatalf("default visibility = %q, want %q: a finished dispatch's children would vanish from its drill-down", got, VisibilitySticky)
	}
}

// A caller that explicitly wants a transient row still gets one. The change
// moves the DEFAULT, it does not remove the option.
func TestDispatchVisibilityHonoursExplicitRequests(t *testing.T) {
	for _, want := range []string{VisibilityEphemeral, VisibilitySticky, VisibilityAlways} {
		if got := resolveDispatchVisibility(want, "agent-1"); got != want {
			t.Errorf("resolveDispatchVisibility(%q) = %q, want it honoured", want, got)
		}
	}
}

// An unrecognized value resolves to sticky rather than failing the dispatch.
// Refusing real work over a roster-presentation string would be worse than
// showing a row for longer than intended.
func TestDispatchVisibilityFallsBackOnUnknownValue(t *testing.T) {
	if got := resolveDispatchVisibility("transient", "agent-1"); got != VisibilitySticky {
		t.Fatalf("unknown visibility = %q, want %q", got, VisibilitySticky)
	}
}
