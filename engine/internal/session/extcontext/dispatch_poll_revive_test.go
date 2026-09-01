package extcontext

import (
	"os"
	"strings"
	"testing"
)

// Regression tests for a dispatched agent parking on a Poll that could never
// wake it.
//
// The engine has three kinds of async work a dispatch can await: child
// dispatches (PendingChildren, woken by NotifyChildComplete), background bash
// tasks (PendingTasks, woken by DeliverTaskResult), and polls. Polls were in no
// wait set and had no delivery path, so a poll-parked dispatch recorded an
// EMPTY wait set. Its revive channel was armed and nothing held a reference
// that could ever signal it: the poll returned its verdict to the root session
// while the dispatch blocked until the 30-minute park backstop fired, reporting
// "park timed out waiting on []".
//
// Observed live: agent-1 parked on poll-3 at 02:04:41, the poll returned
// "satisfied" at 02:05:04, and the agent still timed out at 02:34:41.
//
// Removing DeliverPollResult, or dropping pendingPollIDs from
// SetSuspendedStateWithWaitingOn, turns these red.

// TestDeliverPollResultRevivesParkedDispatch is the core assertion: a poll the
// dispatch is parked on drains its wait set and signals revive.
func TestDeliverPollResultRevivesParkedDispatch(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-poll-1", "agent-1", func() {}, nil, "sess-1", "", 0)

	reviveCh := make(chan struct{}, 1)
	if !r.SetSuspendedStateWithWaitingOn("disp-poll-1", reviveCh, nil, nil, []string{"poll-1"}) {
		t.Fatal("park refused: the poll should have been recorded as awaited work")
	}

	owner, revived := r.DeliverPollResult("poll-1", PollResultRecord{Verdict: "satisfied", Evidence: "test evidence"})

	if owner != "disp-poll-1" {
		t.Fatalf("owner = %q, want the parked dispatch: the verdict would have gone to the root while the dispatch blocked", owner)
	}
	if !revived {
		t.Fatal("revived = false: the wait set drained, so the dispatch must be signalled")
	}
	select {
	case <-reviveCh:
	default:
		t.Fatal("revive channel not signalled: the dispatch would block until the park backstop fired")
	}
}

// A poll no dispatch awaits belongs to the root session. The caller falls
// through to its root delivery paths, exactly as before.
func TestDeliverPollResultIgnoresUnawaitedPoll(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-poll-2", "agent-1", func() {}, nil, "sess-1", "", 0)

	owner, revived := r.DeliverPollResult("poll-nobody-awaits", PollResultRecord{Verdict: "satisfied", Evidence: "test evidence"})

	if owner != "" || revived {
		t.Fatalf("owner=%q revived=%v, want no owner: a root poll must not be attributed to a dispatch", owner, revived)
	}
}

// A dispatch awaiting several polls revives only when the last one lands,
// matching the child-dispatch rule.
func TestDeliverPollResultWaitsForEveryPoll(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-poll-3", "agent-1", func() {}, nil, "sess-1", "", 0)

	reviveCh := make(chan struct{}, 1)
	if !r.SetSuspendedStateWithWaitingOn("disp-poll-3", reviveCh, nil, nil, []string{"poll-a", "poll-b"}) {
		t.Fatal("park refused")
	}

	if owner, revived := r.DeliverPollResult("poll-a", PollResultRecord{Verdict: "satisfied", Evidence: "test evidence"}); owner != "disp-poll-3" || revived {
		t.Fatalf("first poll: owner=%q revived=%v, want owner recorded but no revive yet", owner, revived)
	}
	select {
	case <-reviveCh:
		t.Fatal("revived early: poll-b is still outstanding")
	default:
	}

	if _, revived := r.DeliverPollResult("poll-b", PollResultRecord{Verdict: "satisfied", Evidence: "test evidence"}); !revived {
		t.Fatal("last poll did not revive the dispatch")
	}
}

// A mixed wait set holds until every kind drains. This is what makes polls a
// peer of tasks and children rather than a set the park silently ignores.
func TestPollDoesNotReviveWhileTasksOutstanding(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-poll-4", "agent-1", func() {}, nil, "sess-1", "", 0)

	reviveCh := make(chan struct{}, 1)
	if !r.SetSuspendedStateWithWaitingOn("disp-poll-4", reviveCh, nil, []string{"bash-1"}, []string{"poll-x"}) {
		t.Fatal("park refused")
	}

	if _, revived := r.DeliverPollResult("poll-x", PollResultRecord{Verdict: "satisfied", Evidence: "test evidence"}); revived {
		t.Fatal("revived with a background task still outstanding")
	}

	if _, revived := r.DeliverTaskResult("bash-1", TaskResultRecord{Status: "completed"}); !revived {
		t.Fatal("draining the last awaited item did not revive the dispatch")
	}
}

// The park must record polls as awaited work. Passing only polls previously
// produced awaitedAny=false and an empty wait set -- the exact "waiting on []"
// state. The snapshot is what the operator reads to answer "what is it waiting
// for", so a poll-only park must name its poll.
func TestPollOnlyParkRecordsWaitSet(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp-poll-5", "agent-1", func() {}, nil, "sess-1", "", 0)

	if !r.SetSuspendedStateWithWaitingOn("disp-poll-5", make(chan struct{}, 1), nil, nil, []string{"poll-only"}) {
		t.Fatal("park refused for a poll-only wait set")
	}

	for _, entry := range r.Snapshot() {
		if entry.DispatchID != "disp-poll-5" {
			continue
		}
		if entry.WaitingOn == nil {
			t.Fatal("WaitingOn is nil: a poll-parked dispatch reports an empty wait set, which is what made a timed-out park print 'waiting on []'")
		}
		if len(entry.WaitingOn.PollIDs) != 1 || entry.WaitingOn.PollIDs[0] != "poll-only" {
			t.Fatalf("WaitingOn.PollIDs = %v, want [poll-only]", entry.WaitingOn.PollIDs)
		}
		return
	}
	t.Fatal("dispatch not found in snapshot")
}

// Regression test for a revive race introduced by parenting the poll-check.
//
// A poll-check child is itself a dispatch. Once it was parented to the run that
// started the poll (926405b62), its completion began reaching
// NotifyChildComplete on that parent -- which knew about PendingChildren and
// PendingTasks but not PendingPolls, and so signalled revive the instant the
// JUDGE finished rather than when the POLL did.
//
// Observed live: at 14:36:18.514 "notifychildcomplete: all children done,
// signalling revive" fired BEFORE "poll verdict delivered to parked dispatch",
// and DeliverPollResult then found an unarmed entry ("wait set not empty" ->
// no revive). The outcome was right only because both landed in the same
// millisecond. A poll that returns "advancing" re-arms for another attempt, so
// the same ordering would wake the agent mid-poll with no verdict at all.
func TestChildCompletionDoesNotReviveWhilePollsOutstanding(t *testing.T) {
	r := NewDispatchRegistry()
	const parent = "dispatch-agent-1"
	r.RegisterWithID(parent, "agent-1", func() {}, nil, "sess-1", "", 1)

	reviveCh := make(chan struct{}, 1)
	if !r.SetSuspendedStateWithWaitingOn(parent, reviveCh, nil, nil, []string{"poll-1"}) {
		t.Fatal("park refused")
	}

	// The poll-check child completes. It is a child dispatch of the parent, so
	// its completion reaches NotifyChildComplete.
	if revived := r.NotifyChildComplete(parent, "dispatch-poll-check"); revived {
		t.Fatal("child completion revived the parent while its poll was still outstanding: the agent would resume with no verdict, and a re-arming poll would leave it awake mid-poll")
	}
	select {
	case <-reviveCh:
		t.Fatal("revive signalled by the judge's completion rather than the poll's verdict")
	default:
	}

	// The poll's own verdict is what revives it.
	if _, revived := r.DeliverPollResult("poll-1", PollResultRecord{Verdict: "satisfied", Evidence: "test evidence"}); !revived {
		t.Fatal("the poll verdict did not revive the parent")
	}
	select {
	case <-reviveCh:
	default:
		t.Fatal("revive channel not signalled by the poll verdict")
	}
}

// Regression test for a revive that woke the agent but told it nothing.
//
// DeliverPollResult originally took only a poll ID: it signalled the revive
// channel and recorded no payload. The dispatch resumed, drained an empty
// child-result set, and was handed the generic "no child results were recorded"
// prompt -- so the agent reported that no terminal verdict ever arrived, while
// the engine's own log line said "poll verdict delivered to parked dispatch".
//
// Reported live by the dispatched agent: "Poll verdict: unavailable / attempts
// observed: 0 / terminal verdict was not recorded after the session was
// revived." The engine log looked correct; the agent's report was the truth.
//
// A wake must carry the verdict that caused it. Dropping the record from
// DeliverPollResult, or skipping DrainPollResults on revive, turns this red.
func TestPollRevivePayloadReachesTheRevivedRun(t *testing.T) {
	r := NewDispatchRegistry()
	const parent = "dispatch-agent-1"
	r.RegisterWithID(parent, "agent-1", func() {}, nil, "sess-1", "", 1)

	reviveCh := make(chan struct{}, 1)
	if !r.SetSuspendedStateWithWaitingOn(parent, reviveCh, nil, nil, []string{"poll-1"}) {
		t.Fatal("park refused")
	}

	if _, revived := r.DeliverPollResult("poll-1", PollResultRecord{
		Verdict:  "satisfied",
		Evidence: "the suite exited 0",
	}); !revived {
		t.Fatal("poll did not revive the dispatch")
	}

	// The verdict must be waiting for the resumed run to drain.
	drained := r.DrainPollResults(parent)
	if len(drained) != 1 {
		t.Fatalf("drained %d poll results, want 1: the revived agent would be told nothing and report the verdict unavailable", len(drained))
	}
	if drained[0].PollID != "poll-1" {
		t.Errorf("PollID = %q, want poll-1", drained[0].PollID)
	}
	if drained[0].Verdict != "satisfied" {
		t.Errorf("Verdict = %q, want satisfied", drained[0].Verdict)
	}
	if drained[0].Evidence == "" {
		t.Error("Evidence is empty: the agent resumes without the reasoning behind its verdict")
	}

	// Draining is destructive, so a second revive does not replay a stale
	// verdict.
	if again := r.DrainPollResults(parent); len(again) != 0 {
		t.Errorf("second drain returned %d results, want 0", len(again))
	}
}

// The resume prompt must actually render the verdict. A payload that reaches
// the registry but not the prompt is the same defect one layer later.
func TestPollReviveResumePromptCarriesVerdict(t *testing.T) {
	prompt := buildPollReviveResumePrompt([]PollResultRecord{
		{PollID: "poll-7", Verdict: "satisfied", Evidence: "exit code 0, all packages ok"},
	})

	for _, want := range []string{"poll-7", "satisfied", "exit code 0, all packages ok"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("resume prompt omits %q: %s", want, prompt)
		}
	}
	// It must NOT be the generic child-results prompt, which is what the agent
	// actually received.
	if strings.Contains(prompt, "no child results were recorded") {
		t.Error("poll revive used the generic no-results prompt; the agent would report its verdict unavailable")
	}
}

// The two tests above pass whether or not runChild actually USES the drained
// verdict: one exercises the registry, the other the prompt builder in
// isolation. Reverting the revive block's poll branch left both green -- the
// same false coverage that let the original defect ship.
//
// This pins the wiring at the call site: the revive path must drain poll
// results and render them through the poll-specific prompt.
func TestReviveBlockWiresPollVerdictIntoTheResumePrompt(t *testing.T) {
	src, err := os.ReadFile("dispatch_agent.go")
	if err != nil {
		t.Fatalf("read dispatch_agent.go: %v", err)
	}
	body := string(src)

	if !strings.Contains(body, "registry.DrainPollResults(agentID)") {
		t.Error("revive path does not drain poll verdicts: a poll-revived agent is told nothing and reports its verdict unavailable")
	}
	if !strings.Contains(body, "buildPollReviveResumePrompt(drainedPolls)") {
		t.Error("revive path does not render poll verdicts: the agent receives the generic no-child-results prompt instead of its verdict")
	}
	if !strings.Contains(body, "InjectionKindPollResult") {
		t.Error("a poll revive is not classified as a poll result")
	}
}
