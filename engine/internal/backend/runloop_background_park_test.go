package backend

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// runloop_background_park_test.go pins the turn-boundary park decision: when
// the model finishes its turn and the session still has background bash
// commands outstanding, the run must park (TaskSuspendEvent) instead of
// completing (TaskCompleteEvent).
//
// This is the half of the cycle that makes "keep working, then go idle" work
// without the model declaring anything up front. The session-layer half (wake,
// re-park) is pinned in session/background_task_wake_cycle_test.go.

// parkTestHarness drives dispatchStopReason with a controllable outstanding
// set and captures the events the run emits.
type parkTestHarness struct {
	b      *ApiBackend
	run    *activeRun
	conv   *conversation.Conversation
	events []types.NormalizedEvent
	exits  int
}

func newParkTestHarness(t *testing.T, outstanding func() []string) *parkTestHarness {
	t.Helper()
	h := &parkTestHarness{}
	h.b = NewApiBackend()
	h.b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		h.events = append(h.events, ev)
	})
	h.b.OnExit(func(_ string, _ *int, _ *string, _ string) { h.exits++ })

	h.conv = conversation.CreateConversation("park-test", "", "test-model")
	h.run = &activeRun{
		requestID: "park-test",
		conv:      h.conv,
		startTime: time.Now(),
		steerCh:   make(chan string, 4),
		suspendCh: make(chan suspendSignal, 1),
		cfg: &RunConfig{
			OutstandingBackgroundTasks: outstanding,
		},
	}
	return h
}

func (h *parkTestHarness) endTurn(t *testing.T) bool {
	t.Helper()
	return h.b.dispatchStopReason(
		context.Background(), h.run, h.conv, RunHooks{}, types.RunOptions{},
		effectiveEarlyStopConfig{}, []types.LlmContentBlock{{Type: "text", Text: "done"}},
		"end_turn", 0, 1, 10, t.TempDir(),
	)
}

func (h *parkTestHarness) suspendEvents() []*types.TaskSuspendEvent {
	var out []*types.TaskSuspendEvent
	for _, ev := range h.events {
		if ts, ok := ev.Data.(*types.TaskSuspendEvent); ok {
			out = append(out, ts)
		}
	}
	return out
}

func (h *parkTestHarness) completeEvents() []*types.TaskCompleteEvent {
	var out []*types.TaskCompleteEvent
	for _, ev := range h.events {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			out = append(out, tc)
		}
	}
	return out
}

// A turn ending with outstanding background commands parks the run and names
// the tasks it is waiting on.
func TestTurnBoundary_ParksWithOutstandingCommands(t *testing.T) {
	h := newParkTestHarness(t, func() []string { return []string{"bash-1", "bash-2"} })

	if done := h.endTurn(t); !done {
		t.Fatal("dispatchStopReason should report the run finished (parked)")
	}

	suspends := h.suspendEvents()
	if len(suspends) != 1 {
		t.Fatalf("expected exactly 1 TaskSuspendEvent, got %d", len(suspends))
	}
	got := suspends[0].AwaitingTaskIDs
	if len(got) != 2 || got[0] != "bash-1" || got[1] != "bash-2" {
		t.Errorf("AwaitingTaskIDs = %v, want [bash-1 bash-2]", got)
	}
	if len(suspends[0].AwaitingDispatchIDs) != 0 {
		t.Errorf("AwaitingDispatchIDs = %v, want empty (this is a shell park, not a dispatch suspend)", suspends[0].AwaitingDispatchIDs)
	}

	// Parking is NOT completing: no TaskCompleteEvent. The work is not done,
	// so nothing may report a result.
	if tc := h.completeEvents(); len(tc) != 0 {
		t.Errorf("a parked run must not emit TaskCompleteEvent, got %d", len(tc))
	}

	// But it MUST emit an exit. This assertion was originally inverted ("a
	// parked run must not emit an exit"), which is what let the defect ship:
	// handleRunExit is what clears engineSession.requestID and unbinds the run
	// key, and the wake path reads exactly that state to choose between
	// steering a completion into a live run and waking a parked session.
	// Without the exit a parked session still looks busy, so a completion
	// arriving while parked steered into a run that had already returned and
	// was silently dropped. See parkForBackgroundTasks.
	if h.exits != 1 {
		t.Errorf("exits = %d, want exactly 1 — the park must run terminal bookkeeping so the "+
			"session stops looking busy, or an arriving completion is steered into a dead run", h.exits)
	}
}

// The no-regression pin: with nothing outstanding the run completes exactly as
// it did before this feature existed.
func TestTurnBoundary_CompletesWithNoOutstandingCommands(t *testing.T) {
	h := newParkTestHarness(t, func() []string { return nil })

	if done := h.endTurn(t); !done {
		t.Fatal("dispatchStopReason should report the run finished")
	}

	if s := h.suspendEvents(); len(s) != 0 {
		t.Errorf("expected no park with an empty outstanding set, got %d TaskSuspendEvent(s)", len(s))
	}
	if tc := h.completeEvents(); len(tc) != 1 {
		t.Fatalf("expected the run to complete normally (1 TaskCompleteEvent), got %d", len(tc))
	}
	if h.exits != 1 {
		t.Errorf("expected exactly 1 exit on normal completion, got %d", h.exits)
	}
}

// A run whose config carries no outstanding-set reader behaves exactly as
// before: no park. This is the path every non-session caller takes.
func TestTurnBoundary_NilReaderNeverParks(t *testing.T) {
	h := newParkTestHarness(t, nil)

	h.endTurn(t)

	if s := h.suspendEvents(); len(s) != 0 {
		t.Errorf("a run with no outstanding-set reader must never park, got %d", len(s))
	}
	if tc := h.completeEvents(); len(tc) != 1 {
		t.Errorf("expected normal completion, got %d TaskCompleteEvent(s)", len(tc))
	}
}

// Ordering pin: an in-flight steer wins over the park. A steer is immediate
// work the model should react to now; parking is for when there is genuinely
// nothing left to do this turn.
func TestTurnBoundary_SteerBeatsPark(t *testing.T) {
	h := newParkTestHarness(t, func() []string { return []string{"bash-1"} })
	h.run.steerCh <- "actually, also check the logs"

	if done := h.endTurn(t); done {
		t.Fatal("a drained steer should continue the run, not finish it")
	}

	if s := h.suspendEvents(); len(s) != 0 {
		t.Errorf("expected no park when a steer was pending, got %d TaskSuspendEvent(s)", len(s))
	}
	if tc := h.completeEvents(); len(tc) != 0 {
		t.Errorf("expected no completion when a steer was pending, got %d", len(tc))
	}
}

// The outstanding set is read LIVE at the turn boundary, not snapshotted at run
// start — the model may start background commands mid-run, and those must
// count toward the park decision.
func TestTurnBoundary_ReadsOutstandingSetLive(t *testing.T) {
	var tasks []string
	h := newParkTestHarness(t, func() []string { return tasks })

	// Set is empty when the run starts; a command is registered mid-run.
	tasks = []string{"bash-late"}

	if done := h.endTurn(t); !done {
		t.Fatal("dispatchStopReason should report the run finished (parked)")
	}
	suspends := h.suspendEvents()
	if len(suspends) != 1 {
		t.Fatalf("expected the live read to see the mid-run command and park, got %d", len(suspends))
	}
	if got := suspends[0].AwaitingTaskIDs; len(got) != 1 || got[0] != "bash-late" {
		t.Errorf("AwaitingTaskIDs = %v, want [bash-late]", got)
	}
}

// SignalParkForBackgroundTasks is the extension-facing entry point (depth-0
// ctx.Suspend). It queues a park that the run drains at its next boundary.
func TestSignalPark_QueuesOnActiveRun(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})

	run := &activeRun{
		requestID: "signal-park",
		suspendCh: make(chan suspendSignal, 1),
	}
	b.mu.Lock()
	b.activeRuns["signal-park"] = run
	b.mu.Unlock()

	if !b.SignalParkForBackgroundTasks("signal-park", []string{"bash-1"}) {
		t.Fatal("SignalParkForBackgroundTasks should accept a park for an active run")
	}
	select {
	case sig := <-run.suspendCh:
		if len(sig.AwaitingTaskIDs) != 1 || sig.AwaitingTaskIDs[0] != "bash-1" {
			t.Errorf("queued signal = %+v, want AwaitingTaskIDs [bash-1]", sig)
		}
	default:
		t.Error("expected a suspend signal to be queued on the run")
	}
}

// An unknown run is refused rather than silently dropped.
func TestSignalPark_UnknownRunRefused(t *testing.T) {
	b := NewApiBackend()
	if b.SignalParkForBackgroundTasks("no-such-run", []string{"bash-1"}) {
		t.Error("SignalParkForBackgroundTasks should refuse an unknown run")
	}
}
