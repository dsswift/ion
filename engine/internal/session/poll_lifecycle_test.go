package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// Regression tests for a poll that outlived every path able to end it.
//
// A dispatched agent at the deepest allowed level started a poll. Its judge
// would sit one level deeper, so the depth guard refused it, returning a
// "not launched" result with no error. The driver read that as a launch: no
// judge meant no callback, no re-arm, and no attempt to notice the deadline.
// The owning agent's park timed out and it ended, and the poll stayed in
// activePolls for the life of the engine. HasPendingWork stayed true, so the
// session read as waiting forever.

func newPollLifecycleSession(t *testing.T) (*Manager, *engineSession, string) {
	t.Helper()
	m := &Manager{sessions: map[string]*engineSession{}}
	key := "poll-lifecycle-session"
	s := &engineSession{key: key, agents: agents.NewRegistry(), activePolls: map[string]*activePoll{}, dispatchRegistry: extcontext.NewDispatchRegistry()}
	m.sessions[key] = s
	return m, s, key
}

// parkOwnerOnPoll registers a dispatch and parks it on pollID, so a verdict is
// delivered to it instead of to the root run.
func parkOwnerOnPoll(t *testing.T, s *engineSession, owner, pollID string) chan struct{} {
	t.Helper()
	s.dispatchRegistry.RegisterWithID(owner, "agent", func(string) {}, nil, s.key, "", 2)
	revive := make(chan struct{}, 1)
	if !s.dispatchRegistry.SetSuspendedStateWithWaitingOn(owner, revive, nil, nil, []string{pollID}) {
		t.Fatal("owner refused to park on its poll")
	}
	return revive
}

func pendingWork(t *testing.T, m *Manager, key string) bool {
	t.Helper()
	fields, ok := m.buildStatusFields(key)
	if !ok {
		t.Fatal("session missing")
	}
	return fields.HasPendingWork
}

// The judge must launch for an owner at the deepest level the guard admits.
func TestPollJudgeDepthCapAdmitsJudgeBelowEveryOwner(t *testing.T) {
	m := &Manager{}
	for owner := 0; owner < extcontext.DefaultMaxDispatchDepth; owner++ {
		opts := m.pollDispatchOptions("session", "poll-1", "judge", "model", t.TempDir(), owner)
		if opts.MaxDispatchDepth != owner+2 {
			t.Errorf("owner depth %d: judge MaxDispatchDepth = %d, want %d so the judge at depth %d launches", owner, opts.MaxDispatchDepth, owner+2, owner+1)
		}
	}
}

// A judge that does not launch ends the poll and frees the session.
func TestPollCheckNotLaunchedEndsPoll(t *testing.T) {
	m, s, key := newPollLifecycleSession(t)
	addPoll(s, "poll-1", "dispatch-deep")
	revive := parkOwnerOnPoll(t, s, "dispatch-deep", "poll-1")

	m.recordPollCheckLaunch(key, "poll-1", 1, &extension.DispatchAgentResult{DepthCapExceeded: true, ExitCode: 1, Output: "dispatch depth cap reached"})

	if _, open := s.activePolls["poll-1"]; open {
		t.Fatal("poll still open after its judge failed to launch: the session reads as waiting forever")
	}
	if fields, _ := m.buildStatusFields(key); fields.PollsWaiting != 0 {
		t.Fatalf("PollsWaiting = %d, want 0: the dead poll would still hold the session in pending work", fields.PollsWaiting)
	}
	select {
	case <-revive:
	default:
		t.Fatal("parked owner not revived: it would wait for its park backstop")
	}
	results := s.dispatchRegistry.DrainPollResults("dispatch-deep")
	if len(results) != 1 || results[0].Verdict != string(types.PollVerdictStuck) {
		t.Fatalf("owner poll results = %+v, want one stuck verdict", results)
	}
}

// A launched judge keeps the poll open and is recorded on it.
func TestPollCheckLaunchedKeepsPollOpen(t *testing.T) {
	m, s, key := newPollLifecycleSession(t)
	addPoll(s, "poll-1", "")

	m.recordPollCheckLaunch(key, "poll-1", 1, &extension.DispatchAgentResult{DispatchID: "dispatch-poll-check-1"})

	poll, open := s.activePolls["poll-1"]
	if !open {
		t.Fatal("poll ended although its judge launched")
	}
	if poll.state.ActiveDispatchID != "dispatch-poll-check-1" {
		t.Fatalf("ActiveDispatchID = %q, want the launched judge", poll.state.ActiveDispatchID)
	}
}

// The deadline ends a poll even when no attempt is scheduled.
func TestPollDeadlineEndsIdlePoll(t *testing.T) {
	m, s, key := newPollLifecycleSession(t)
	id, err := m.registerPoll(s, key, "dispatch-deep", tools.PollRequest{Intent: "wait", Model: "model", Deadline: 20 * time.Millisecond}, t.TempDir())
	if err != nil {
		t.Fatalf("registerPoll: %v", err)
	}
	revive := parkOwnerOnPoll(t, s, "dispatch-deep", id)

	select {
	case <-revive:
	case <-time.After(2 * time.Second):
		t.Fatal("deadline passed without ending the poll")
	}
	m.mu.RLock()
	_, open := s.activePolls[id]
	m.mu.RUnlock()
	if open {
		t.Fatal("poll still open after its deadline")
	}
	results := s.dispatchRegistry.DrainPollResults("dispatch-deep")
	if len(results) != 1 || results[0].Verdict != string(types.PollVerdictExhausted) {
		t.Fatalf("owner poll results = %+v, want one exhausted verdict", results)
	}
}

// A dispatch that ends releases its own polls and no one else's.
func TestReleaseDispatchPollsEndsOnlyOwnedPolls(t *testing.T) {
	m, s, key := newPollLifecycleSession(t)
	var terminals []string
	m.onEvent = func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_poll_terminal" {
			terminals = append(terminals, ev.PollTerminal.PollID)
		}
	}
	addPoll(s, "poll-a", "dispatch-a")
	addPoll(s, "poll-b", "dispatch-a")
	addPoll(s, "poll-other", "dispatch-b")

	m.releaseDispatchPolls(key, "dispatch-a")

	if _, open := s.activePolls["poll-a"]; open {
		t.Error("poll-a outlived its owning dispatch")
	}
	if _, open := s.activePolls["poll-b"]; open {
		t.Error("poll-b outlived its owning dispatch")
	}
	if _, open := s.activePolls["poll-other"]; !open {
		t.Error("another dispatch's poll was released")
	}
	if len(terminals) != 2 {
		t.Errorf("terminal events = %v, want one per released poll", terminals)
	}

	m.releaseDispatchPolls(key, "dispatch-b")
	if pendingWork(t, m, key) {
		t.Fatal("HasPendingWork still true after every owner ended")
	}
}

// The root's polls have no owning dispatch, so an empty id releases nothing.
func TestReleaseDispatchPollsIgnoresRoot(t *testing.T) {
	m, s, key := newPollLifecycleSession(t)
	addPoll(s, "poll-root", "")
	m.releaseDispatchPolls(key, "")
	if _, open := s.activePolls["poll-root"]; !open {
		t.Fatal("a root poll was released")
	}
}
