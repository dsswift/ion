package agents

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Regression test for a stale dispatch permanently holding an agent's row.
//
// Representative selection was statusPriority alone (running=4, suspended=3,
// error=2, done=1). Between two FINISHED dispatches of the same name that made
// an old failed run outrank a new successful one, because error=2 beats done=1
// regardless of age. The emitted row then carried the stale dispatch's
// displayName, task, and lastWork, so an operator's just-completed dispatch was
// absent from the agent panel while an hours-old failure held its slot.
//
// Observed live: three "agent-1" dispatches at 16:36, 18:36 and 21:20 in one
// session. The 21:20 run finished `done`; the 18:36 run had finished `error`.
// Every snapshot after 21:21 emitted the 18:36 row, and the operator reported
// their dispatch missing from the panel while its drill-down still worked.
//
// The rule is now liveness first, then most recently started. Reverting to
// statusPriority turns these red.

func rowAt(id, status string, startedAt int64, task string) types.AgentStateUpdate {
	return types.AgentStateUpdate{
		Name:   "agent-1",
		ID:     id,
		Status: status,
		Metadata: map[string]interface{}{
			"startTime":  startedAt,
			"task":       task,
			"visibility": "sticky",
			"invited":    true,
		},
	}
}

// The core assertion: a newer `done` must outrank an older `error`.
func TestNewerDoneBeatsOlderError(t *testing.T) {
	r := NewRegistry()
	noop := func(*types.AgentStateUpdate) {}
	r.AppendOrUpdateByID(rowAt("stale", "error", 1000, "an old failed run"), noop)
	r.AppendOrUpdateByID(rowAt("live", "done", 2000, "the operator's dispatch"), noop)

	for _, row := range r.MergedSnapshot() {
		if row.Name != "agent-1" {
			continue
		}
		if task, _ := row.Metadata["task"].(string); task != "the operator's dispatch" {
			t.Fatalf("representative task = %q, want the newest dispatch: an hours-old failure is holding the operator's row", task)
		}
		return
	}
	t.Fatal("no agent-1 row in snapshot")
}

// Liveness still outranks recency: a running dispatch is what the operator sees
// while it runs, even when an older sibling started first.
func TestRunningBeatsNewerTerminal(t *testing.T) {
	older := rowAt("running-older", "running", 1000, "still working")
	newerDone := rowAt("done-newer", "done", 5000, "already finished")

	if representativeBeats(newerDone, older) {
		t.Error("a finished dispatch displaced a running one: live work must be visible while it runs")
	}
	if !representativeBeats(older, newerDone) {
		t.Error("the running dispatch did not win its slot")
	}
}

// A suspended dispatch is alive (parked on children, a task, or a poll), so it
// must not be displaced by a terminal sibling either.
func TestSuspendedCountsAsLive(t *testing.T) {
	suspended := rowAt("parked", "suspended", 1000, "parked on a poll")
	terminal := rowAt("finished", "error", 9000, "newer failure")

	if representativeBeats(terminal, suspended) {
		t.Error("a terminal dispatch displaced a suspended one: a parked dispatch is still in flight")
	}
}

// Among terminal entries, outcome does not decide — recency does. This is the
// specific inversion that caused the live defect.
func TestTerminalOrderingIgnoresOutcome(t *testing.T) {
	cases := []struct{ newer, older string }{
		{"done", "error"},
		{"error", "done"},
		{"cancelled", "error"},
		{"done", "cancelled"},
	}
	for _, tc := range cases {
		newer := rowAt("newer", tc.newer, 2000, "newer")
		older := rowAt("older", tc.older, 1000, "older")
		if !representativeBeats(newer, older) {
			t.Errorf("newer %q lost to older %q: terminal ordering must be by recency, not outcome", tc.newer, tc.older)
		}
	}
}

// Metadata round-trips through JSON, where startTime arrives as float64. It must
// compare identically to an in-process int64 or recency flips after a rehydrate.
func TestStartedAtReadsJSONNumbers(t *testing.T) {
	inProcess := types.AgentStateUpdate{Metadata: map[string]interface{}{"startTime": int64(1234)}}
	rehydrated := types.AgentStateUpdate{Metadata: map[string]interface{}{"startTime": float64(1234)}}

	if startedAtOf(inProcess.Metadata) != startedAtOf(rehydrated.Metadata) {
		t.Fatalf("int64 %d != float64 %d: a rehydrated snapshot would reorder", startedAtOf(inProcess.Metadata), startedAtOf(rehydrated.Metadata))
	}
	if startedAtOf(nil) != 0 {
		t.Error("absent metadata should sort oldest")
	}
}
