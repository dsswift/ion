package extcontext

import (
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// waitForParkStatus blocks until the dispatch's registry snapshot reads want.
func waitForParkStatus(t *testing.T, registry *DispatchRegistry, id, want string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		var status string
		for _, e := range registry.Snapshot() {
			if e.DispatchID == id {
				status = e.Status
			}
		}
		if status == want {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("dispatch %s never reached status %q (last %q)", id, want, status)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestDispatch_ParkCheckIn_WakesParkedDispatchAndReparks pins the check-in end
// to end: a parked dispatch that declared an interval is woken with the
// dispatcher's prompt while its child is still running, resumes its own
// conversation classified as a check-in, parks again when that turn ends, and
// still completes normally when the child finally finishes.
//
// Revert bar: without the check-in the park has only the revive, recall, and
// ceiling branches, so the second run never starts until the child completes
// and its prompt is the child's result, not the check-in.
func TestDispatch_ParkCheckIn_WakesParkedDispatchAndReparks(t *testing.T) {
	registry := NewDispatchRegistry()

	park := childRunScript{
		events: []types.NormalizedEvent{
			{Data: &types.SessionInitEvent{SessionID: "conv-parent"}},
			{Data: &types.TaskSuspendEvent{AwaitingDispatchIDs: []string{"child-1"}}},
		},
		code: 0, signal: "suspended",
	}
	child := newScriptedChildBackend(park, park, childRunScript{
		events: []types.NormalizedEvent{
			{Data: &types.TaskCompleteEvent{Result: "final result", SessionID: "conv-parent"}},
		},
		code: 0,
	})
	acc := &idTestAccessor{child: child}
	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")
	// The awaited child is live in the registry, so the check-in can describe it.
	registry.RegisterWithID("child-1", "code-engineer", func(string) {}, nil, "sess", "", 2)
	registry.UpdateActivity("child-1", 7, "editing files")

	var asked atomic.Int32
	infoCh := make(chan extension.DispatchParkCheckInInfo, 1)
	completeCh := make(chan extension.DispatchAgentResult, 1)
	errCh := make(chan extension.DispatchError, 1)
	stub, err := dispatchFn(extension.DispatchAgentOpts{
		Name:                  "lead",
		Task:                  "delegate and wait",
		Background:            true,
		ParkCheckInIntervalMs: 30,
		OnParkCheckIn: func(info extension.DispatchParkCheckInInfo) (extension.DispatchParkCheckInReply, error) {
			// Only the first tick delivers; later ticks skip so the second
			// park holds until the child completes.
			if asked.Add(1) > 1 {
				return extension.DispatchParkCheckInReply{Skip: true}, nil
			}
			infoCh <- info
			return extension.DispatchParkCheckInReply{Prompt: "check on child-1"}, nil
		},
		OnComplete: func(r extension.DispatchAgentResult) { completeCh <- r },
		OnError:    func(e extension.DispatchError) { errCh <- e },
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	parentID := stub.DispatchID

	var info extension.DispatchParkCheckInInfo
	select {
	case info = <-infoCh:
	case <-time.After(5 * time.Second):
		t.Fatal("OnParkCheckIn never fired for the parked dispatch")
	}
	if info.DispatchID != parentID || info.Name != "lead" || info.CheckInCount != 1 {
		t.Errorf("check-in info = %+v, want dispatch %s, name lead, count 1", info, parentID)
	}
	if len(info.AwaitingDispatchIDs) != 1 || info.AwaitingDispatchIDs[0] != "child-1" {
		t.Errorf("AwaitingDispatchIDs = %v, want [child-1]", info.AwaitingDispatchIDs)
	}

	if len(info.AwaitingDispatches) != 1 || info.AwaitingDispatches[0].Name != "code-engineer" || info.AwaitingDispatches[0].ToolCount != 7 {
		t.Errorf("AwaitingDispatches = %+v, want the live state of code-engineer with 7 tool calls", info.AwaitingDispatches)
	}

	// The check-in run starts, then parks again on the same child.
	deadline := time.After(5 * time.Second)
	for len(child.recordedOpts()) < 2 {
		select {
		case <-deadline:
			t.Fatal("check-in never started a second run")
		case <-time.After(10 * time.Millisecond):
		}
	}
	second := child.recordedOpts()[1]
	if second.Prompt != "check on child-1" {
		t.Errorf("check-in run prompt = %q, want the dispatcher's prompt", second.Prompt)
	}
	if second.InjectionKind != string(types.InjectionKindCheckIn) {
		t.Errorf("check-in run InjectionKind = %q, want %q", second.InjectionKind, types.InjectionKindCheckIn)
	}
	if second.ConversationID != "conv-parent" {
		t.Errorf("check-in run ConversationID = %q, want the dispatch's own conversation", second.ConversationID)
	}
	waitForParkStatus(t, registry, parentID, "suspended")
	select {
	case r := <-completeCh:
		t.Fatalf("OnComplete fired after the check-in (result %q); the dispatch must park again", r.Output)
	case e := <-errCh:
		t.Fatalf("OnError fired after the check-in: %s", e.Message)
	default:
	}

	// The child finishing still revives and completes the dispatch.
	if !registry.NotifyChildComplete(parentID, "child-1") {
		t.Fatal("NotifyChildComplete did not signal the re-parked dispatch")
	}
	select {
	case r := <-completeCh:
		if !strings.Contains(r.Output, "final result") {
			t.Errorf("completion output = %q, want the post-revive run's result", r.Output)
		}
	case e := <-errCh:
		t.Fatalf("OnError fired instead of OnComplete: %s", e.Message)
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch never completed after its child finished")
	}
}

// newTestParkWait builds a parkWait over test-owned channels.
func newTestParkWait(interval time.Duration) (parkWait, chan struct{}, chan struct{}) {
	reviveCh := make(chan struct{}, 1)
	recalled := make(chan struct{})
	return parkWait{
		reviveCh:        reviveCh,
		recalled:        recalled,
		timeout:         5 * time.Second,
		checkInInterval: interval,
		claim:           func() bool { return true },
		info: extension.DispatchParkCheckInInfo{
			Name:                "lead",
			DispatchID:          "d-1",
			AwaitingDispatchIDs: []string{"child-1"},
			AwaitingTaskIDs:     []string{"task-9"},
		},
		awaiting: func() []extension.DispatchStateEntry {
			return []extension.DispatchStateEntry{{DispatchID: "child-1", Name: "code-engineer", ToolCount: 12, LastWork: "running tests"}}
		},
	}, reviveCh, recalled
}

// TestParkWait_NoIntervalNeverChecksIn pins the additive contract: a dispatch
// that declared no interval waits only on its revive, recall, and ceiling.
func TestParkWait_NoIntervalNeverChecksIn(t *testing.T) {
	w, _, _ := newTestParkWait(0)
	w.timeout = 80 * time.Millisecond
	w.ask = func(extension.DispatchParkCheckInInfo) (extension.DispatchParkCheckInReply, error) {
		t.Error("ask called with no interval declared")
		return extension.DispatchParkCheckInReply{}, nil
	}
	if got := w.wait(); got.reason != parkWakeTimedOut {
		t.Fatalf("wake reason = %q, want %q", got.reason, parkWakeTimedOut)
	}
}

// TestParkWait_DefaultPromptNamesAwaitedWork pins the engine's generic prompt
// for a dispatcher that declared an interval and no callback.
func TestParkWait_DefaultPromptNamesAwaitedWork(t *testing.T) {
	w, _, _ := newTestParkWait(10 * time.Millisecond)
	got := w.wait()
	if got.reason != parkWakeCheckIn {
		t.Fatalf("wake reason = %q, want %q", got.reason, parkWakeCheckIn)
	}
	for _, want := range []string{"code-engineer", "child-1", "12 tool calls", "running tests", "task-9", "Do NOT restart"} {
		if !strings.Contains(got.prompt, want) {
			t.Errorf("default prompt missing %q:\n%s", want, got.prompt)
		}
	}
}

// TestParkWait_SkipAndErrorKeepParked pins that a skipped or failed check-in
// leaves the dispatch parked and the next interval still fires.
func TestParkWait_SkipAndErrorKeepParked(t *testing.T) {
	w, _, _ := newTestParkWait(10 * time.Millisecond)
	var calls atomic.Int32
	w.ask = func(info extension.DispatchParkCheckInInfo) (extension.DispatchParkCheckInReply, error) {
		switch calls.Add(1) {
		case 1:
			return extension.DispatchParkCheckInReply{Skip: true}, nil
		case 2:
			return extension.DispatchParkCheckInReply{}, errors.New("extension gone")
		default:
			if info.CheckInCount != 3 {
				t.Errorf("CheckInCount = %d, want 3", info.CheckInCount)
			}
			return extension.DispatchParkCheckInReply{Prompt: "third time"}, nil
		}
	}
	got := w.wait()
	if got.reason != parkWakeCheckIn || got.prompt != "third time" {
		t.Fatalf("wake = %+v, want a check-in carrying the third answer", got)
	}
}

// TestParkWait_ReviveBeatsCheckInWhenClaimFails pins the race rule: when the
// awaited work settles while the check-in prompt is being resolved, the claim
// fails and the wait reports the revive, so the dispatch resumes with its
// results instead of a stale check-in.
func TestParkWait_ReviveBeatsCheckInWhenClaimFails(t *testing.T) {
	w, reviveCh, _ := newTestParkWait(10 * time.Millisecond)
	w.claim = func() bool {
		reviveCh <- struct{}{}
		return false
	}
	if got := w.wait(); got.reason != parkWakeRevived {
		t.Fatalf("wake reason = %q, want %q", got.reason, parkWakeRevived)
	}
}

// TestParkWait_RecallEndsWait pins that a recall is still observed while a
// check-in interval is armed.
func TestParkWait_RecallEndsWait(t *testing.T) {
	w, _, recalled := newTestParkWait(time.Hour)
	close(recalled)
	if got := w.wait(); got.reason != parkWakeRecalled {
		t.Fatalf("wake reason = %q, want %q", got.reason, parkWakeRecalled)
	}
}

// TestDispatchRegistry_ClaimParkForCheckIn pins the claim: it succeeds once on
// an armed park and clears the suspended state, and fails once the revive has
// been signalled or the park was already claimed.
func TestDispatchRegistry_ClaimParkForCheckIn(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("d-claim", "lead", func(string) {}, nil, "sess", "", 1)
	if r.ClaimParkForCheckIn("d-claim") {
		t.Fatal("claim succeeded on a dispatch that is not parked")
	}

	r.SetSuspendedState("d-claim", make(chan struct{}, 1), []string{"child-1"})
	if !r.ClaimParkForCheckIn("d-claim") {
		t.Fatal("claim failed on an armed park")
	}
	for _, e := range r.Snapshot() {
		if e.DispatchID == "d-claim" && e.Status != "running" {
			t.Errorf("status after claim = %q, want running", e.Status)
		}
	}
	if r.ClaimParkForCheckIn("d-claim") {
		t.Fatal("second claim succeeded on an already-claimed park")
	}

	r.SetSuspendedState("d-claim", make(chan struct{}, 1), []string{"child-1"})
	if !r.NotifyChildComplete("d-claim", "child-1") {
		t.Fatal("NotifyChildComplete did not signal the park")
	}
	if r.ClaimParkForCheckIn("d-claim") {
		t.Fatal("claim succeeded after the revive was already signalled")
	}
}
