package extcontext

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for the dispatch-lifecycle fixes:
//
//   - Park-on-children round trip (root cause A): a dispatched parent whose
//     run parks (suspend shape) is held open as "suspended", revived when its
//     child completes, and only then reaches a terminal callback.
//   - Cancel maps to error (root cause J): a child run the engine cancelled
//     (not recalled) surfaces as OnError with a non-zero exit, never as a
//     clean OnComplete.
//   - Notify on every terminal path (root cause C): a parent's pending set is
//     decremented when its child ERRORS, not only when it succeeds.
//   - Detached opt-out: a detached child never appears in its parent's
//     ChildIDsOf park set.
//   - SubAgentPolicy (root cause B): "allowlist" with an empty list denies
//     all nested dispatch; "" preserves the historic non-empty-only check;
//     "unrestricted" opts out.

// scriptedChildBackend is a controllable child RunBackend: each StartRun
// call replays the next script entry (a sequence of NormalizedEvents plus an
// exit code/signal). Cancel fires the "cancelled" exit shape the real
// ApiBackend produces for an engine-initiated cancel. Every StartRun's
// RunOptions is recorded (startOpts) so tests can pin the revive-resume
// contract: the second run must carry the child's ConversationID and a
// results-bearing prompt, never a replay of the original task.
type scriptedChildBackend struct {
	mu     sync.Mutex
	onNorm func(string, types.NormalizedEvent)
	onExit func(string, *int, *string, string)

	// scripts[i] drives the i-th StartRun call.
	scripts []childRunScript
	calls   int
	// startOpts[i] is the RunOptions the i-th StartRun received.
	startOpts []types.RunOptions

	// started signals each StartRun invocation (buffered).
	started chan string
}

type childRunScript struct {
	events []types.NormalizedEvent
	code   int
	signal string // "" = none
	// hold, when non-nil, delays the exit until the channel is closed.
	hold chan struct{}
}

func newScriptedChildBackend(scripts ...childRunScript) *scriptedChildBackend {
	return &scriptedChildBackend{scripts: scripts, started: make(chan string, 8)}
}

func (s *scriptedChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	s.mu.Lock()
	s.onNorm = fn
	s.mu.Unlock()
}
func (s *scriptedChildBackend) OnExit(fn func(string, *int, *string, string)) {
	s.mu.Lock()
	s.onExit = fn
	s.mu.Unlock()
}
func (s *scriptedChildBackend) OnError(func(string, error))            {}
func (s *scriptedChildBackend) Cancel(string) bool                     { return false }
func (s *scriptedChildBackend) IsRunning(string) bool                  { return false }
func (s *scriptedChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (s *scriptedChildBackend) FlushConversations()                    {}
func (s *scriptedChildBackend) Capabilities() backend.BackendCapabilities {
	return backend.BackendCapabilities{Kind: "mock", ContextModel: backend.ContextModelEngineOwned}
}

func (s *scriptedChildBackend) StartRun(requestID string, opts types.RunOptions) {
	s.mu.Lock()
	idx := s.calls
	s.calls++
	s.startOpts = append(s.startOpts, opts)
	onNorm, onExit := s.onNorm, s.onExit
	var script childRunScript
	if idx < len(s.scripts) {
		script = s.scripts[idx]
	}
	s.mu.Unlock()

	select {
	case s.started <- requestID:
	default:
	}

	go func() {
		if onNorm != nil {
			for _, ev := range script.events {
				onNorm(requestID, ev)
			}
		}
		if script.hold != nil {
			<-script.hold
		}
		if onExit != nil {
			code := script.code
			var sig *string
			if script.signal != "" {
				sigVal := script.signal
				sig = &sigVal
			}
			onExit(requestID, &code, sig, "conv-scripted")
		}
	}()
}

// suspendStatusOf reads the recorded agent state's status for id.
func suspendStatusOf(acc *idTestAccessor, id string) string {
	acc.mu.Lock()
	defer acc.mu.Unlock()
	if st, ok := acc.stateByID[id]; ok {
		return st.Status
	}
	return ""
}

// TestDispatch_ParkOnChildren_SuspendReviveRoundTrip pins root cause A end to
// end at the dispatch layer: a background parent whose FIRST run emits
// TaskSuspendEvent (the engine's park-on-children shape) then exits with the
// "suspended" signal is held as status "suspended" with OnComplete NOT fired;
// when its awaited child completes (NotifyChildComplete), the parent's run
// restarts and the SECOND run's completion fires OnComplete exactly once.
//
// Revert bar: on the pre-fix engine there is no turn-boundary park, so the
// first run completes and OnComplete fires with the child still running.
func TestDispatch_ParkOnChildren_SuspendReviveRoundTrip(t *testing.T) {
	registry := NewDispatchRegistry()

	// Script: run 1 parks awaiting child-1; run 2 (post-revive) completes.
	child := newScriptedChildBackend(
		childRunScript{
			events: []types.NormalizedEvent{
				{Data: &types.SessionInitEvent{SessionID: "conv-parent"}},
				{Data: &types.TaskSuspendEvent{AwaitingDispatchIDs: []string{"child-1"}}},
			},
			code: 0, signal: "suspended",
		},
		childRunScript{
			events: []types.NormalizedEvent{
				{Data: &types.TaskCompleteEvent{Result: "post-revive result", SessionID: "conv-parent"}},
			},
			code: 0,
		},
	)
	acc := &idTestAccessor{child: child}
	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")

	completeCh := make(chan extension.DispatchAgentResult, 1)
	errCh := make(chan extension.DispatchError, 1)
	stub, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "lead",
		Task:       "park then revive",
		Background: true,
		OnComplete: func(r extension.DispatchAgentResult) { completeCh <- r },
		OnError:    func(e extension.DispatchError) { errCh <- e },
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	parentID := stub.DispatchID

	// Wait for the park: the parent's registry entry flips Suspended and the
	// agent state reads "suspended".
	deadline := time.After(5 * time.Second)
	for {
		snap := registry.Snapshot()
		var status string
		for _, e := range snap {
			if e.DispatchID == parentID {
				status = e.Status
			}
		}
		if status == "suspended" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("parent never reached suspended in registry snapshot (status=%q, agent state=%q)", status, suspendStatusOf(acc, parentID))
		case <-time.After(20 * time.Millisecond):
		}
	}
	if got := suspendStatusOf(acc, parentID); got != "suspended" {
		t.Errorf("agent state status = %q, want suspended", got)
	}
	select {
	case r := <-completeCh:
		t.Fatalf("OnComplete fired while parked (result %q) — the park must hold the dispatch open", r.Output)
	default:
	}

	// Pending children must surface in the snapshot (H1).
	var pending []string
	for _, e := range registry.Snapshot() {
		if e.DispatchID == parentID {
			pending = e.PendingChildren
		}
	}
	if len(pending) != 1 || pending[0] != "child-1" {
		t.Errorf("PendingChildren = %v, want [child-1]", pending)
	}

	// Child completes → revive → run 2 → OnComplete exactly once.
	if !registry.NotifyChildComplete(parentID, "child-1") {
		t.Fatal("NotifyChildComplete did not signal the parked parent")
	}
	select {
	case r := <-completeCh:
		if !strings.Contains(r.Output, "post-revive result") {
			t.Errorf("completion output = %q, want the post-revive run's result", r.Output)
		}
		if r.ExitCode != 0 {
			t.Errorf("exit code = %d, want 0", r.ExitCode)
		}
	case e := <-errCh:
		t.Fatalf("OnError fired instead of OnComplete: %s", e.Message)
	case <-time.After(5 * time.Second):
		t.Fatal("parent never completed after revive")
	}
	select {
	case <-completeCh:
		t.Fatal("OnComplete fired twice")
	case <-time.After(200 * time.Millisecond):
	}
}

// TestDispatch_EngineCancelMapsToError pins root cause J: a child run that
// exits with the engine's "cancelled" signal (watchdog stall kill, abort)
// WITHOUT a recall must surface as OnError with a non-zero exit code and a
// message naming the cancellation — never as a clean OnComplete. The SAME
// terminal error must also be persisted in the child conversation: otherwise
// the dispatch row is correctly red while its popup ends on ordinary assistant
// prose and looks successful, the exact contradiction reported in conversation
// 1785612472900-430418ea3e39.
//
// Revert bar: with OnExit discarding code/signal (the pre-fix wiring), this
// dispatch builds ExitCode 0 and fires OnComplete. With the state transition
// intact but AppendDispatchError removed, the callback arm passes and the child
// history assertion goes red.
func TestDispatch_EngineCancelMapsToError(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	childConv := conversation.CreateConversation("conv-cancelled", "system", "model")
	conversation.AddUserMessage(childConv, "do work")
	conversation.AddAssistantMessageNoUsage(childConv, []types.LlmContentBlock{{Type: "text", Text: "partial work before the kill"}})
	if err := conversation.Save(childConv, ""); err != nil {
		t.Fatalf("seed child conversation: %v", err)
	}

	child := newScriptedChildBackend(
		childRunScript{
			events: []types.NormalizedEvent{
				{Data: &types.SessionInitEvent{SessionID: "conv-cancelled"}},
				{Data: &types.TextChunkEvent{Text: "partial work before the kill"}},
			},
			code: 0, signal: "cancelled",
		},
	)
	acc := &idTestAccessor{child: child}
	dispatchFn := BuildDispatchAgentFunc(acc, NewDispatchRegistry(), 0, "")

	completeCh := make(chan extension.DispatchAgentResult, 1)
	errCh := make(chan extension.DispatchError, 1)
	_, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "doomed",
		Task:       "get watchdog-killed",
		Background: true,
		OnComplete: func(r extension.DispatchAgentResult) { completeCh <- r },
		OnError:    func(e extension.DispatchError) { errCh <- e },
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}

	select {
	case e := <-errCh:
		if e.ExitCode == 0 {
			t.Errorf("ExitCode = 0 on a cancelled run, want non-zero")
		}
		if !strings.Contains(e.Message, "cancelled") {
			t.Errorf("error message %q does not name the cancellation", e.Message)
		}
	case r := <-completeCh:
		t.Fatalf("OnComplete fired for an engine-cancelled run (output %q) — the kill was costume-dressed as success", r.Output)
	case <-time.After(5 * time.Second):
		t.Fatal("no terminal callback")
	}

	messages, err := conversation.LoadMessages("conv-cancelled", "")
	if err != nil {
		t.Fatalf("load child conversation after dispatch error: %v", err)
	}
	var errorRows int
	for _, msg := range messages {
		if msg.Role == "system" && strings.Contains(msg.Content, "Error: run cancelled by engine") {
			errorRows++
		}
	}
	if errorRows != 1 {
		t.Fatalf("child history error rows = %d, want 1; messages=%+v", errorRows, messages)
	}
}

// TestDispatch_NotifyChildComplete_FiresOnErrorPath pins root cause C: a
// child that terminates with an ERROR still notifies its suspended parent's
// pending set. The registry-level decrement logic is covered by
// dispatch_suspend_test.go; this test drives the full dispatch path — the
// notify call must run on the OnError branch, not only inside the success
// branch (the pre-fix placement).
func TestDispatch_NotifyChildComplete_FiresOnErrorPath(t *testing.T) {
	registry := NewDispatchRegistry()

	// A suspended parent awaiting exactly this child.
	registry.RegisterWithID("parent-disp", "lead", func() {}, nil, "sess", "", 1)
	reviveCh := make(chan struct{}, 1)

	// The child errors (non-zero exit).
	child := newScriptedChildBackend(
		childRunScript{
			events: []types.NormalizedEvent{
				{Data: &types.SessionInitEvent{SessionID: "conv-err-child"}},
			},
			code: 1,
		},
	)
	acc := &idTestAccessor{child: child}
	// currentDispatchId = "parent-disp": this dispatch is the parent's child.
	dispatchFn := BuildDispatchAgentFunc(acc, registry, 1, "parent-disp")

	errCh := make(chan extension.DispatchError, 1)
	stub, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "failing-child",
		Task:       "error out",
		Background: true,
		OnError:    func(e extension.DispatchError) { errCh <- e },
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	// Park the parent on the child's ACTUAL dispatch id.
	registry.SetSuspendedState("parent-disp", reviveCh, []string{stub.DispatchID})

	select {
	case <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("child never errored")
	}
	select {
	case <-reviveCh:
		// Expected: the erroring child still empties the pending set.
	case <-time.After(2 * time.Second):
		t.Fatal("parent not revived after its child ERRORED — NotifyChildComplete only ran on the success branch")
	}
}

// TestDispatchRegistry_ChildIDsOf_DetachedExcluded pins the Detached opt-out:
// a detached child never appears in its parent's park set, and non-detached
// children do.
func TestDispatchRegistry_ChildIDsOf_DetachedExcluded(t *testing.T) {
	r := NewDispatchRegistry()
	r.Reserve("parent", "lead", "", 1)
	r.Reserve("kid-a", "spec-a", "parent", 2)
	r.Reserve("kid-b", "spec-b", "parent", 2)
	r.MarkDetached("kid-b")

	ids := r.ChildIDsOf("parent")
	if len(ids) != 1 || ids[0] != "kid-a" {
		t.Errorf("ChildIDsOf = %v, want [kid-a] (kid-b is detached)", ids)
	}
	if got := r.ChildIDsOf(""); got != nil {
		t.Errorf("ChildIDsOf(\"\") = %v, want nil", got)
	}

	// The detached flag must survive the Reserve → RegisterWithID upgrade.
	r.RegisterWithID("kid-b", "spec-b", func() {}, nil, "sess", "parent", 2)
	if ids := r.ChildIDsOf("parent"); len(ids) != 1 {
		t.Errorf("after RegisterWithID upgrade, ChildIDsOf = %v, want [kid-a] — Detached flag lost in upgrade", ids)
	}
}

// recordedOpts returns a copy of the RunOptions each StartRun call received.
func (s *scriptedChildBackend) recordedOpts() []types.RunOptions {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]types.RunOptions, len(s.startOpts))
	copy(out, s.startOpts)
	return out
}

// TestDispatch_ReviveResumesConversation_NeverReplays pins root cause K (the
// 1785418884327 incident): a revived parent must RESUME — the second run
// carries the parent's own ConversationID (so its pre-park work is in
// history) and a prompt bearing the awaited child's actual result — never a
// replay of the original task in a fresh conversation.
//
// Revert bar: on the pre-fix wiring the second StartRun receives the
// ORIGINAL runOpts verbatim (Prompt == the original task, ConversationID ==
// ""), which is exactly what made the lead replay step 1 three times.
func TestDispatch_ReviveResumesConversation_NeverReplays(t *testing.T) {
	registry := NewDispatchRegistry()

	child := newScriptedChildBackend(
		// Run 1: init (captures the conversation id), then park awaiting child-9.
		childRunScript{
			events: []types.NormalizedEvent{
				{Data: &types.SessionInitEvent{SessionID: "conv-lead-77"}},
				{Data: &types.TaskSuspendEvent{AwaitingDispatchIDs: []string{"child-9"}}},
			},
			code: 0, signal: "suspended",
		},
		// Run 2 (post-revive): completes.
		childRunScript{
			events: []types.NormalizedEvent{
				{Data: &types.TaskCompleteEvent{Result: "consolidated report", SessionID: "conv-lead-77"}},
			},
			code: 0,
		},
	)
	acc := &idTestAccessor{child: child}
	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")

	completeCh := make(chan extension.DispatchAgentResult, 1)
	stub, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "lead",
		Task:       "ORIGINAL TASK: do two parts",
		Background: true,
		OnComplete: func(r extension.DispatchAgentResult) { completeCh <- r },
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	parentID := stub.DispatchID

	// Wait for the park.
	deadline := time.After(5 * time.Second)
	for {
		suspended := false
		for _, e := range registry.Snapshot() {
			if e.DispatchID == parentID && e.Status == "suspended" {
				suspended = true
			}
		}
		if suspended {
			break
		}
		select {
		case <-deadline:
			t.Fatal("parent never parked")
		case <-time.After(20 * time.Millisecond):
		}
	}

	// The awaited child completes WITH a result recorded on the parent —
	// the same sequence the child terminal path performs.
	registry.RecordChildResult(parentID, ChildResultRecord{
		ChildID: "child-9", Name: "engine-dev", Output: "PART B DONE: 3 lines written", ExitCode: 0,
	})
	if !registry.NotifyChildComplete(parentID, "child-9") {
		t.Fatal("NotifyChildComplete did not revive the parent")
	}

	select {
	case <-completeCh:
	case <-time.After(5 * time.Second):
		t.Fatal("parent never completed after revive")
	}

	opts := child.recordedOpts()
	if len(opts) != 2 {
		t.Fatalf("StartRun calls = %d, want 2 (park + revive)", len(opts))
	}
	// Run 1: the original dispatch shape.
	if opts[0].Prompt != "ORIGINAL TASK: do two parts" {
		t.Errorf("run 1 prompt = %q, want the original task", opts[0].Prompt)
	}
	// Run 2: a RESUME — the parent's own conversation, and the child's
	// result as the prompt. Never the original task again.
	if opts[1].ConversationID != "conv-lead-77" {
		t.Errorf("run 2 ConversationID = %q, want conv-lead-77 (resume, not a fresh conversation)", opts[1].ConversationID)
	}
	if opts[1].Prompt == opts[0].Prompt {
		t.Fatalf("run 2 replayed the original task — the revive must inject the child result instead")
	}
	if !strings.Contains(opts[1].Prompt, "PART B DONE: 3 lines written") {
		t.Errorf("run 2 prompt %q does not carry the child's result", opts[1].Prompt)
	}
	if !strings.Contains(opts[1].Prompt, "do NOT restart") {
		t.Errorf("run 2 prompt %q does not carry the no-restart instruction", opts[1].Prompt)
	}

	// The drained results must not be re-delivered on a later revive.
	if again := registry.DrainChildResults(parentID); len(again) != 0 {
		t.Errorf("child results not cleared after drain: %v", again)
	}
}

// TestDispatchRegistry_SetSuspendedState_PrunesCompletedChildren pins the
// park/complete race guard: a child that finished BEFORE the parent's park
// armed (its NotifyChildComplete hit a nil ReviveCh and will never fire
// again) must not be counted as pending. All-children-already-done returns
// false so the caller revives immediately instead of parking forever.
func TestDispatchRegistry_SetSuspendedState_PrunesCompletedChildren(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("p-race", "lead", func() {}, nil, "sess", "", 1)

	// child-a completed before the park armed; its result is recorded.
	r.RecordChildResult("p-race", ChildResultRecord{ChildID: "child-a", Name: "spec-a", Output: "done early", ExitCode: 0})

	// Park awaiting child-a AND child-b: child-a must be pruned, leaving
	// only child-b pending; the park proceeds (true).
	ch := make(chan struct{}, 1)
	if !r.SetSuspendedState("p-race", ch, []string{"child-a", "child-b"}) {
		t.Fatal("park with one still-pending child must arm (true)")
	}
	// child-b completing must fully revive (child-a is not lingering).
	if !r.NotifyChildComplete("p-race", "child-b") {
		t.Fatal("last pending child completion must signal revive")
	}

	// Park awaiting ONLY the already-completed child: must refuse to arm.
	r.RecordChildResult("p-race", ChildResultRecord{ChildID: "child-c", Name: "spec-c", Output: "also early", ExitCode: 0})
	ch2 := make(chan struct{}, 1)
	if r.SetSuspendedState("p-race", ch2, []string{"child-c"}) {
		t.Fatal("park whose every awaited child already completed must return false (immediate revive)")
	}
}
