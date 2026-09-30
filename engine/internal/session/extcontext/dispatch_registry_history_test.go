package extcontext

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func historyIDs(entries []DispatchTerminalEntry) []string {
	ids := make([]string, len(entries))
	for i, e := range entries {
		ids[i] = e.DispatchID
	}
	return ids
}

// TestDispatchHistory_DeregisterRetainsTerminalEntry pins that a completed
// dispatch leaves the live snapshot and is retained with its final status,
// reason, completion time, and lineage.
func TestDispatchHistory_DeregisterRetainsTerminalEntry(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("dispatch-parent", "lead", func() {}, nil, "sess", "", 1)
	r.RegisterWithID("dispatch-child", "worker", func() {}, nil, "sess", "dispatch-parent", 2)
	r.SetChildConvID("dispatch-child", "conv-child")
	r.UpdateActivity("dispatch-child", 3, "Using Bash...")

	before := time.Now()
	r.Deregister("dispatch-child", DispatchOutcome{Status: DispatchStatusError, Reason: "boom", ExitCode: 1})

	if got := len(r.Snapshot()); got != 1 {
		t.Fatalf("live snapshot has %d entries, want only the parent", got)
	}
	history := r.History()
	if len(history) != 1 {
		t.Fatalf("history = %+v, want one entry", history)
	}
	e := history[0]
	if e.DispatchID != "dispatch-child" || e.Name != "worker" || e.ParentDispatchID != "dispatch-parent" || e.Depth != 2 {
		t.Errorf("lineage not preserved: %+v", e)
	}
	if e.Status != DispatchStatusError || e.Reason != "boom" || e.ExitCode == nil || *e.ExitCode != 1 {
		t.Errorf("outcome not preserved: %+v", e)
	}
	if e.CompletedAt.Before(before) || e.StartedAt.After(e.CompletedAt) {
		t.Errorf("timestamps wrong: started %v completed %v (deregistered after %v)", e.StartedAt, e.CompletedAt, before)
	}
	if e.ToolCount != 3 || e.ChildConversationID != "conv-child" {
		t.Errorf("activity not preserved: %+v", e)
	}

	// A second Deregister for the same ID is a no-op, not a duplicate record.
	r.Deregister("dispatch-child", DispatchOutcome{Status: DispatchStatusDone})
	if got := len(r.History()); got != 1 {
		t.Fatalf("history has %d entries after a repeat Deregister, want 1", got)
	}
}

// TestDispatchHistory_CountBoundEvictsOldest pins count-bounded eviction:
// the oldest completions go first.
func TestDispatchHistory_CountBoundEvictsOldest(t *testing.T) {
	r := NewDispatchRegistry()
	r.SetHistoryLimits(&types.DispatchHistoryConfig{MaxEntries: 2})
	for _, id := range []string{"d-1", "d-2", "d-3"} {
		r.RegisterWithID(id, "agent", func() {}, nil, "sess", "", 1)
		r.Deregister(id, DispatchOutcome{Status: DispatchStatusDone})
	}
	if got, want := historyIDs(r.History()), []string{"d-2", "d-3"}; !slices.Equal(got, want) {
		t.Fatalf("history = %v, want %v", got, want)
	}

	// Shrinking the bound evicts at once.
	r.SetHistoryLimits(&types.DispatchHistoryConfig{MaxEntries: 1})
	if got, want := historyIDs(r.History()), []string{"d-3"}; !slices.Equal(got, want) {
		t.Fatalf("history after shrink = %v, want %v", got, want)
	}
}

// TestDispatchHistory_AgeBoundEvictsOnRead pins that an entry older than the
// age bound is not returned, even when no later completion triggered a prune.
func TestDispatchHistory_AgeBoundEvictsOnRead(t *testing.T) {
	r := NewDispatchRegistry()
	r.SetHistoryLimits(&types.DispatchHistoryConfig{MaxAgeMs: 60_000})
	for _, id := range []string{"old", "fresh"} {
		r.RegisterWithID(id, "agent", func() {}, nil, "sess", "", 1)
		r.Deregister(id, DispatchOutcome{Status: DispatchStatusDone})
	}
	r.mu.Lock()
	r.history.entries[0].CompletedAt = time.Now().Add(-2 * time.Minute)
	r.mu.Unlock()

	if got, want := historyIDs(r.History()), []string{"fresh"}; !slices.Equal(got, want) {
		t.Fatalf("history = %v, want %v", got, want)
	}
}

// TestDispatchHistory_NegativeMaxEntriesDisablesRetention pins the off switch.
func TestDispatchHistory_NegativeMaxEntriesDisablesRetention(t *testing.T) {
	r := NewDispatchRegistry()
	r.SetHistoryLimits(&types.DispatchHistoryConfig{MaxEntries: -1})
	r.RegisterWithID("d-1", "agent", func() {}, nil, "sess", "", 1)
	r.Deregister("d-1", DispatchOutcome{Status: DispatchStatusDone})
	if got := r.History(); len(got) != 0 {
		t.Fatalf("history = %+v, want nothing retained", got)
	}
}

// TestDispatchHistory_RecallCascadeRetainsCancelled pins that a recall records
// the target and every descendant as cancelled with the recall reason, at
// recall time, and that the dispatch's later Deregister does not overwrite it.
func TestDispatchHistory_RecallCascadeRetainsCancelled(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("parent", "lead", func() {}, nil, "sess", "", 1)
	r.RegisterWithID("child", "worker", func() {}, nil, "sess", "parent", 2)
	r.RegisterWithID("bystander", "worker", func() {}, nil, "sess", "", 1)

	if !r.RecallByID("parent", "timeout guard") {
		t.Fatal("RecallByID(parent) = false")
	}
	r.Deregister("parent", DispatchOutcome{Status: DispatchStatusDone})

	history := r.History()
	if got := historyIDs(history); !slices.Equal(got, []string{"parent", "child"}) {
		t.Fatalf("history = %v, want parent and child", got)
	}
	for _, e := range history {
		if e.Status != DispatchStatusCancelled || e.Reason != "timeout guard" || e.ExitCode == nil || *e.ExitCode != ExitCodeRecalled {
			t.Errorf("entry %s = %+v, want cancelled with the recall reason", e.DispatchID, e)
		}
	}
}

// TestDispatchHistory_RecallAllRetainsCancelledAndDropsAliases pins session
// teardown: every live dispatch is retained as cancelled, and consumer aliases
// do not outlive them.
func TestDispatchHistory_RecallAllRetainsCancelledAndDropsAliases(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("d-1", "agent", func() {}, nil, "sess", "", 1)
	r.RegisterAlias("local-1", "d-1")

	if n := r.RecallAll("session stopped"); n != 1 {
		t.Fatalf("RecallAll = %d, want 1", n)
	}
	history := r.History()
	if len(history) != 1 || history[0].Status != DispatchStatusCancelled || history[0].Reason != "session stopped" {
		t.Fatalf("history = %+v, want one cancelled entry with the teardown reason", history)
	}
	r.mu.Lock()
	aliases := len(r.aliases)
	r.mu.Unlock()
	if aliases != 0 {
		t.Fatalf("aliases = %d after RecallAll, want 0", aliases)
	}
}

// TestDispatchHistory_OwnershipMatchesLiveRule pins that a dispatched owner
// sees only its strict descendants, including a finished grandchild whose own
// parent also finished, and never itself, a sibling, or another branch.
func TestDispatchHistory_OwnershipMatchesLiveRule(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("owner", "lead", func() {}, nil, "sess", "", 1)
	r.RegisterWithID("child", "worker", func() {}, nil, "sess", "owner", 2)
	r.RegisterWithID("grandchild", "helper", func() {}, nil, "sess", "child", 3)
	r.RegisterWithID("sibling", "worker", func() {}, nil, "sess", "", 1)
	r.RegisterWithID("nephew", "helper", func() {}, nil, "sess", "sibling", 2)

	done := DispatchOutcome{Status: DispatchStatusDone}
	r.Deregister("grandchild", done)
	r.Deregister("child", done)
	r.Deregister("nephew", done)
	r.Deregister("sibling", done)

	if got, want := historyIDs(r.OwnedHistory("owner")), []string{"grandchild", "child"}; !slices.Equal(got, want) {
		t.Fatalf("owner sees %v, want %v", got, want)
	}
	if got := historyIDs(r.OwnedHistory("")); len(got) != 4 {
		t.Fatalf("root sees %v, want all four", got)
	}

	r.Deregister("owner", done)
	if got := historyIDs(r.OwnedHistory("owner")); slices.Contains(got, "owner") {
		t.Fatalf("owner sees itself: %v", got)
	}
}

// TestDispatchHistory_MissingLineageFailsClosed pins that once a parent link
// is evicted, a dispatched owner can no longer prove descent and the entry is
// hidden from it (root still sees it).
func TestDispatchHistory_MissingLineageFailsClosed(t *testing.T) {
	r := NewDispatchRegistry()
	r.SetHistoryLimits(&types.DispatchHistoryConfig{MaxEntries: 1})
	r.RegisterWithID("owner", "lead", func() {}, nil, "sess", "", 1)
	r.RegisterWithID("child", "worker", func() {}, nil, "sess", "owner", 2)
	r.RegisterWithID("grandchild", "helper", func() {}, nil, "sess", "child", 3)
	done := DispatchOutcome{Status: DispatchStatusDone}
	r.Deregister("child", done)
	r.Deregister("grandchild", done) // evicts child

	if got := r.OwnedHistory("owner"); len(got) != 0 {
		t.Fatalf("owner sees %v through an evicted link, want nothing", historyIDs(got))
	}
	if got := historyIDs(r.OwnedHistory("")); !slices.Equal(got, []string{"grandchild"}) {
		t.Fatalf("root sees %v, want grandchild", got)
	}
}

// TestDispatchExitOutcome pins the precedence the exit path uses, which
// matches the terminal agent-state transition: recalled, then error, then done.
func TestDispatchExitOutcome(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name     string
		recalled bool
		err      error
		want     DispatchOutcome
	}{
		{"recalled wins over error", true, boom, DispatchOutcome{Status: DispatchStatusCancelled, Reason: "recall_agent", ExitCode: 7}},
		{"error", false, boom, DispatchOutcome{Status: DispatchStatusError, Reason: "boom", ExitCode: 7}},
		{"done", false, nil, DispatchOutcome{Status: DispatchStatusDone, ExitCode: 7}},
	}
	for _, tc := range cases {
		if got := dispatchExitOutcome(tc.recalled, "recall_agent", tc.err, 7); got != tc.want {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}
