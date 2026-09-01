package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// Regression test for the Poll self-deadlock.
//
// Poll resolves its intent by dispatching a "poll-check" child, and that child
// is a run inside the SAME session. When the park set was read session-wide,
// the poll-check child parked on the very poll it had been dispatched to
// resolve: the poll could not finish until the child answered, and the child
// would not run until the poll finished. Every poll started inside a dispatch
// burned its full 30-minute deadline and returned "stuck".
//
// The fix attributes each poll to the run that started it (activePoll.owner)
// and scopes the reader to that owner, mirroring OutstandingChildDispatches.
//
// Reverting the fix -- returning every poll in the session regardless of owner
// -- turns TestPollParkSetExcludesOtherRunsPolls red.

func newPollOwnerSession(t *testing.T) (*Manager, *engineSession, string) {
	t.Helper()
	m := &Manager{sessions: map[string]*engineSession{}}
	key := "poll-owner-session"
	s := &engineSession{activePolls: map[string]*activePoll{}}
	m.sessions[key] = s
	return m, s, key
}

// addPoll registers a poll directly, bypassing the dispatch machinery that
// startPoll would otherwise drive. Only the owner attribution is under test.
func addPoll(s *engineSession, id, owner string) {
	s.activePolls[id] = &activePoll{
		state:    types.PollState{PollID: id, DeadlineAt: time.Now().Add(time.Minute).UnixMilli()},
		owner:    owner,
		deadline: time.Now().Add(time.Minute),
	}
}

// TestPollParkSetExcludesOtherRunsPolls is the deadlock guard: the poll-check
// child dispatched to resolve a poll must not see that poll in its own park
// set.
func TestPollParkSetExcludesOtherRunsPolls(t *testing.T) {
	m, s, key := newPollOwnerSession(t)

	// A dispatched agent starts a poll...
	addPoll(s, "poll-1", "dispatch-agent-1")
	// ...and Poll dispatches a poll-check child to judge the evidence. That
	// child is a separate run with its own dispatch ID.
	const pollCheckChild = "dispatch-poll-check-1"

	got := m.OutstandingPollIDsFor(key, pollCheckChild)
	if len(got) != 0 {
		t.Fatalf("poll-check child would park on the poll it exists to resolve: got %v", got)
	}

	// The run that actually started the poll still parks on it, otherwise the
	// dispatch would complete while its poll was still running.
	own := m.OutstandingPollIDsFor(key, "dispatch-agent-1")
	if len(own) != 1 || own[0] != "poll-1" {
		t.Fatalf("the starting run does not park on its own poll: got %v", own)
	}
}

// TestPollParkSetIsPerOwner pins that sibling dispatches do not hold each other
// open, which is the same failure with a different pair of runs.
func TestPollParkSetIsPerOwner(t *testing.T) {
	m, s, key := newPollOwnerSession(t)
	addPoll(s, "poll-a", "dispatch-a")
	addPoll(s, "poll-b", "dispatch-b")

	a := m.OutstandingPollIDsFor(key, "dispatch-a")
	if len(a) != 1 || a[0] != "poll-a" {
		t.Errorf("dispatch-a park set wrong: got %v", a)
	}
	b := m.OutstandingPollIDsFor(key, "dispatch-b")
	if len(b) != 1 || b[0] != "poll-b" {
		t.Errorf("dispatch-b park set wrong: got %v", b)
	}
}

// TestRootPollParkSetExcludesDispatchPolls pins the root's side of the same
// rule: a dispatched agent's poll must not hold the root run open.
func TestRootPollParkSetExcludesDispatchPolls(t *testing.T) {
	m, s, key := newPollOwnerSession(t)
	addPoll(s, "poll-root", "")
	addPoll(s, "poll-child", "dispatch-agent-1")

	root := m.OutstandingPollIDsFor(key, "")
	if len(root) != 1 || root[0] != "poll-root" {
		t.Fatalf("root parks on the wrong set: got %v", root)
	}
}

// TestPollParkSetEmptyForUnknownSession guards the nil-session path: a reader
// for a session that has gone away reports no work rather than panicking.
func TestPollParkSetEmptyForUnknownSession(t *testing.T) {
	m, _, _ := newPollOwnerSession(t)
	if got := m.OutstandingPollIDsFor("no-such-session", ""); got != nil {
		t.Errorf("expected nil for an unknown session, got %v", got)
	}
}
