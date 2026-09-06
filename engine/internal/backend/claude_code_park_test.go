package backend

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// parkProbe wires a ClaudeCodeBackend to a recorder so a test can see what the
// turn boundary emitted.
type parkProbe struct {
	b      *ClaudeCodeBackend
	run    *claudeCodeRun
	mu     sync.Mutex
	events []types.NormalizedEvent
}

func newParkProbe(t *testing.T) *parkProbe {
	t.Helper()
	p := &parkProbe{b: NewClaudeCodeBackend(), run: &claudeCodeRun{requestID: "req-park"}}
	p.b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.events = append(p.events, ev)
	})
	return p
}

func (p *parkProbe) suspends() []*types.TaskSuspendEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []*types.TaskSuspendEvent
	for _, ev := range p.events {
		if ts, ok := ev.Data.(*types.TaskSuspendEvent); ok {
			out = append(out, ts)
		}
	}
	return out
}

// park mirrors the result-event call site exactly: take the decision, then emit
// the suspend when it says to. Tests assert against this rather than the two
// functions separately, so a call site that took the decision and forgot to act
// on it would not be pinned by a green test.
func (p *parkProbe) park(opts types.RunOptions) bool {
	parking, tasks, polls := p.b.delegatedParkDecision(p.run, opts)
	if parking {
		p.b.emitDelegatedPark(p.run, tasks, polls)
	}
	return parking
}

// TestParkDelegatedRun_OutstandingTaskParks is the regression test for the
// reported defect. A delegated CLI run that reaches its turn boundary with a
// notifying command still running must suspend, not complete: the suspend is
// what the session records as a park, and a park is the only state a later
// completion can wake.
//
// Revert-check: remove the emitDelegatedPark call from the result-event case and
// the run reports completion with work in flight — no suspend is emitted and
// this goes red.
func TestParkDelegatedRun_OutstandingTaskParks(t *testing.T) {
	p := newParkProbe(t)
	opts := types.RunOptions{
		OutstandingBackgroundTasks: func() []string { return []string{"bash-1"} },
	}

	if !p.park(opts) {
		t.Fatal("the turn boundary did not park with a task outstanding; the completion would have been emitted")
	}

	suspends := p.suspends()
	if len(suspends) != 1 {
		t.Fatalf("emitted %d suspend events, want exactly 1", len(suspends))
	}
	if got := suspends[0].AwaitingTaskIDs; len(got) != 1 || got[0] != "bash-1" {
		t.Errorf("AwaitingTaskIDs = %v, want [bash-1]", got)
	}
}

// TestParkDelegatedRun_OutstandingPollParks pins the other seam. A poll holds a
// root session open for the same reason a background command does, and the API
// backend parks on either.
func TestParkDelegatedRun_OutstandingPollParks(t *testing.T) {
	p := newParkProbe(t)
	opts := types.RunOptions{
		OutstandingPolls: func() []string { return []string{"poll-7"} },
	}

	if !p.park(opts) {
		t.Fatal("the turn boundary did not park with a poll outstanding")
	}
	suspends := p.suspends()
	if len(suspends) != 1 {
		t.Fatalf("emitted %d suspend events, want exactly 1", len(suspends))
	}
	if got := suspends[0].AwaitingPollIDs; len(got) != 1 || got[0] != "poll-7" {
		t.Errorf("AwaitingPollIDs = %v, want [poll-7]", got)
	}
}

// TestParkDelegatedRun_EmptySetCompletes pins that a run with nothing in flight
// finishes normally. Parking on an empty set would strand every ordinary
// conversation until the park timeout fired.
func TestParkDelegatedRun_EmptySetCompletes(t *testing.T) {
	p := newParkProbe(t)
	opts := types.RunOptions{
		OutstandingBackgroundTasks: func() []string { return nil },
		OutstandingPolls:           func() []string { return []string{} },
	}

	if p.park(opts) {
		t.Fatal("the turn boundary parked with an empty outstanding set")
	}
	if got := p.suspends(); len(got) != 0 {
		t.Fatalf("emitted %d suspend events on an empty set, want 0", len(got))
	}
}

// TestParkDelegatedRun_NilSeamsCompleteUnchanged pins the compatibility arm.
// Every consumer that predates these seams passes RunOptions with both nil, and
// must keep completing exactly as it did.
func TestParkDelegatedRun_NilSeamsCompleteUnchanged(t *testing.T) {
	p := newParkProbe(t)

	if p.park(types.RunOptions{}) {
		t.Fatal("the turn boundary parked on a run with no outstanding seams wired")
	}
	if got := p.suspends(); len(got) != 0 {
		t.Fatalf("emitted %d suspend events with nil seams, want 0", len(got))
	}
}

// TestNormalizeRunCost_ParkHoldsBaseline is the regression test for the silent
// accounting loss. A park suppresses the TaskCompleteEvent, which on this
// backend is the only carrier of cost and usage — so advancing the cumulative
// baseline on a parked turn erases that turn's spend from this run AND from the
// woken run's delta, which is measured from the advanced mark. Nothing errors;
// the conversation's aggregate is simply short, forever.
//
// The second call is the point: it stands in for the woken turn and must bill
// the whole span, not just what was spent after the park.
//
// Revert-check: drop the `parking` guard from normalizeRunCost (or take the
// park decision after it, as the original call site did) and the woken run
// reports 0.40 instead of 1.00 — this goes red while every other park test
// stays green.
func TestNormalizeRunCost_ParkHoldsBaseline(t *testing.T) {
	p := newParkProbe(t)

	// Turn one spends 0.60 and parks on an outstanding command.
	parked := &types.TaskCompleteEvent{CostUsd: 0.60}
	p.b.normalizeRunCost(p.run.requestID, "cli-session", parked, true)

	p.b.mu.Lock()
	baseline := p.b.lastCumulativeCost["cli-session"]
	p.b.mu.Unlock()
	if baseline != 0 {
		t.Fatalf("baseline advanced to %v on a parked turn; the turn's spend is now unreachable", baseline)
	}

	// Turn two is the wake. The CLI reports the session cumulative, which
	// includes what turn one spent.
	woken := &types.TaskCompleteEvent{CostUsd: 1.00}
	p.b.normalizeRunCost(p.run.requestID, "cli-session", woken, false)

	if woken.CostUsd != 1.00 {
		t.Errorf("woken run billed %v, want 1.00 (0.60 parked + 0.40 after the wake)", woken.CostUsd)
	}
	p.b.mu.Lock()
	baseline = p.b.lastCumulativeCost["cli-session"]
	p.b.mu.Unlock()
	if baseline != 1.00 {
		t.Errorf("baseline after the completing turn = %v, want 1.00", baseline)
	}
}

// TestNormalizeRunCost_CompletingTurnSubtractsBaseline pins the ordinary arm so
// the guard above cannot be "fixed" by never advancing the baseline at all.
func TestNormalizeRunCost_CompletingTurnSubtractsBaseline(t *testing.T) {
	p := newParkProbe(t)

	first := &types.TaskCompleteEvent{CostUsd: 0.25}
	p.b.normalizeRunCost(p.run.requestID, "cli-session", first, false)
	if first.CostUsd != 0.25 {
		t.Fatalf("first run billed %v, want 0.25", first.CostUsd)
	}

	second := &types.TaskCompleteEvent{CostUsd: 0.75}
	p.b.normalizeRunCost(p.run.requestID, "cli-session", second, false)
	if second.CostUsd != 0.50 {
		t.Errorf("second run billed %v, want 0.50 (the delta, not the cumulative)", second.CostUsd)
	}
}
