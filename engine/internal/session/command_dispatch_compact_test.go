// Tests for the /compact dispatch path. dispatchCompact routes through
// three code paths depending on backend capability and run state:
//
//   1. Backend implements compactable (ApiBackend, HybridBackend on API-routed
//      runs) → CompactNow is called and the result event is emitted.
//   2. Backend does NOT implement compactable + active run → forward /compact
//      as a stream-json user message over WriteToStdin.
//   3. Backend does NOT implement compactable + no active run → emit
//      engine_command_result with CommandError="compact_requires_active_run"
//      and an informational EventMessage.

package session

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// compactingMockBackend extends mockBackend with the compactable
// interface and records every CompactNow invocation so tests can
// assert what was passed in.
//
// Concurrency knobs for the async Path-A tests:
//   - gate: when non-nil, CompactNow blocks on it before returning, letting a
//     test hold a compaction "in flight" while it asserts guard behavior.
//   - lastCtx: the context CompactNow was invoked with, captured so a test can
//     assert cancellation propagates from the session root.
type compactingMockBackend struct {
	*mockBackend

	mu       sync.Mutex
	requests []backend.CompactRequest
	respond  func() error  // returns the error CompactNow will report; nil = success
	gate     chan struct{} // when non-nil, CompactNow blocks until closed/received
	lastCtx  context.Context
}

func newCompactingMockBackend() *compactingMockBackend {
	return &compactingMockBackend{mockBackend: newMockBackend()}
}

func (m *compactingMockBackend) CompactNow(ctx context.Context, req backend.CompactRequest) error {
	m.mu.Lock()
	m.requests = append(m.requests, req)
	respond := m.respond
	gate := m.gate
	m.lastCtx = ctx
	m.mu.Unlock()
	if gate != nil {
		// Block until the gate is released or the context is cancelled, so a
		// test can (a) hold the compaction in flight and (b) verify ctx
		// cancellation aborts it.
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if respond != nil {
		return respond()
	}
	return nil
}

// capturedCtx returns the context the most recent CompactNow was called with.
func (m *compactingMockBackend) capturedCtx() context.Context {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastCtx
}

// requestCount returns how many times CompactNow has been invoked.
func (m *compactingMockBackend) requestCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.requests)
}

// stdinCapturingBackend records every WriteToStdin call so the CLI-path
// test can verify the literal "/compact" text was forwarded as a
// stream-json user message. Does NOT implement compactable.
type stdinCapturingBackend struct {
	*mockBackend

	mu     sync.Mutex
	writes []stdinWrite
}

type stdinWrite struct {
	requestID string
	msg       interface{}
}

func newStdinCapturingBackend() *stdinCapturingBackend {
	return &stdinCapturingBackend{mockBackend: newMockBackend()}
}

func (m *stdinCapturingBackend) WriteToStdin(requestID string, msg interface{}) error {
	m.mu.Lock()
	m.writes = append(m.writes, stdinWrite{requestID: requestID, msg: msg})
	m.mu.Unlock()
	return nil
}

// TestDispatchCompact_EmptyConversationID exercises the no-conversation
// short-circuit. Mirrors clear/export's empty-session behavior.
//
// Note: StartSession pre-mints a conversation ID even for fresh sessions
// (see start_session.go:418), so we have to clear it explicitly to
// exercise this branch. Real-world callers hit this when the session
// was created without a SessionID and the agent loop has not yet run a
// turn that would persist anything to disk.
func TestDispatchCompact_EmptyConversationID(t *testing.T) {
	mb := newCompactingMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("empty-conv", defaultConfig())

	mgr.mu.Lock()
	mgr.sessions["empty-conv"].conversationID = ""
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("empty-conv", "compact", "")

	if got := mb.requests; len(got) != 0 {
		t.Errorf("expected no CompactNow calls for empty conversationID; got %d", len(got))
	}

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 engine_command_result, got %d", len(results))
	}
	if results[0].event.CommandError != "" {
		t.Errorf("expected no CommandError for empty-conv compact; got %q", results[0].event.CommandError)
	}
}

// TestDispatchCompact_APIPath verifies the compactable type assertion
// succeeds for backends that implement it, CompactNow is called with the
// session's conversation ID and last-known model, and a success
// engine_command_result lands. Path A is async (CompactNow runs on a
// goroutine), so the test polls for the result rather than reading it
// synchronously.
func TestDispatchCompact_APIPath(t *testing.T) {
	mb := newCompactingMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-compact", defaultConfig())

	// Seed the session's conversation ID and last model — dispatchCompact
	// reads both. Production code populates these via the engine_status
	// translation path; the test sets them directly.
	mgr.mu.Lock()
	s := mgr.sessions["api-compact"]
	s.conversationID = "conv-abc-123"
	s.lastModel = "claude-opus-4-7"
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("api-compact", "compact", "")

	// Async: wait for the goroutine to emit its single result.
	if !waitForCount(func() int { return len(ec.byType("engine_command_result")) }, 1) {
		t.Fatalf("timed out waiting for async engine_command_result")
	}

	mb.mu.Lock()
	gotRequests := append([]backend.CompactRequest{}, mb.requests...)
	mb.mu.Unlock()

	if len(gotRequests) != 1 {
		t.Fatalf("expected exactly 1 CompactNow call, got %d", len(gotRequests))
	}
	req := gotRequests[0]
	if req.ConversationID != "conv-abc-123" {
		t.Errorf("ConversationID = %q, want %q", req.ConversationID, "conv-abc-123")
	}
	if req.Model != "claude-opus-4-7" {
		t.Errorf("Model = %q, want %q", req.Model, "claude-opus-4-7")
	}
	if req.RequestID == "" {
		t.Errorf("RequestID is empty; expected synthetic ID")
	}

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 engine_command_result, got %d", len(results))
	}
	if results[0].event.CommandError != "" {
		t.Errorf("expected success; got CommandError=%q", results[0].event.CommandError)
	}

	// The in-flight flag must be cleared once the goroutine finishes.
	mgr.mu.Lock()
	stillInFlight := mgr.sessions["api-compact"].compactInFlight
	mgr.mu.Unlock()
	if stillInFlight {
		t.Errorf("compactInFlight should be cleared after compaction completes")
	}
}

// TestDispatchCompact_APIPath_Error verifies that a CompactNow error
// surfaces in the engine_command_result as CommandError. Async path — poll
// for the result.
func TestDispatchCompact_APIPath_Error(t *testing.T) {
	mb := newCompactingMockBackend()
	mb.respond = func() error { return errors.New("synthetic failure") }
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-err", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["api-err"]
	s.conversationID = "conv-err"
	s.lastModel = "claude-sonnet-4-6"
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("api-err", "compact", "")

	if !waitForCount(func() int { return len(ec.byType("engine_command_result")) }, 1) {
		t.Fatalf("timed out waiting for async engine_command_result")
	}

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 engine_command_result, got %d", len(results))
	}
	if results[0].event.CommandError == "" {
		t.Errorf("expected CommandError to be set after CompactNow failure")
	}
}

// TestDispatchCompact_CLIPath_ActiveRun exercises the fallback when the
// backend does NOT implement compactable but a run IS active: /compact
// is forwarded over stdin as a stream-json user message and a success
// engine_command_result lands.
func TestDispatchCompact_CLIPath_ActiveRun(t *testing.T) {
	mb := newStdinCapturingBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli-compact", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["cli-compact"]
	s.conversationID = "conv-cli"
	s.requestID = "run-in-flight-xyz"
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("cli-compact", "compact", "")

	mb.mu.Lock()
	writes := append([]stdinWrite{}, mb.writes...)
	mb.mu.Unlock()

	if len(writes) != 1 {
		t.Fatalf("expected exactly 1 WriteToStdin call, got %d", len(writes))
	}
	if writes[0].requestID != "run-in-flight-xyz" {
		t.Errorf("WriteToStdin requestID = %q, want %q", writes[0].requestID, "run-in-flight-xyz")
	}

	// Verify the payload shape: type=user, message.content[0].text="/compact".
	m, ok := writes[0].msg.(map[string]interface{})
	if !ok {
		t.Fatalf("stdin message is not a map; got %T", writes[0].msg)
	}
	if m["type"] != "user" {
		t.Errorf("stdin message type = %v, want %q", m["type"], "user")
	}
	msgInner, ok := m["message"].(map[string]interface{})
	if !ok {
		t.Fatalf("message.message is not a map; got %T", m["message"])
	}
	contentList, ok := msgInner["content"].([]map[string]interface{})
	if !ok {
		t.Fatalf("message.content is not []map; got %T", msgInner["content"])
	}
	if len(contentList) != 1 {
		t.Fatalf("content has %d blocks, want 1", len(contentList))
	}
	if contentList[0]["text"] != "/compact" {
		t.Errorf("content[0].text = %v, want %q", contentList[0]["text"], "/compact")
	}

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 engine_command_result, got %d", len(results))
	}
	if results[0].event.CommandError != "" {
		t.Errorf("expected success; got CommandError=%q", results[0].event.CommandError)
	}
}

// TestDispatchCompact_CLIPath_NoActiveRun exercises the informational
// error path when the backend does NOT implement compactable AND has no
// active run. The engine_command_result must carry the
// compact_requires_active_run sentinel so consumers can render a friendly
// system message.
func TestDispatchCompact_CLIPath_NoActiveRun(t *testing.T) {
	mb := newStdinCapturingBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli-no-run", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["cli-no-run"]
	s.conversationID = "conv-cli-idle"
	// s.requestID stays "" — no active run.
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("cli-no-run", "compact", "")

	mb.mu.Lock()
	writes := append([]stdinWrite{}, mb.writes...)
	mb.mu.Unlock()

	if len(writes) != 0 {
		t.Errorf("expected no WriteToStdin calls when run is idle; got %d", len(writes))
	}

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 engine_command_result, got %d", len(results))
	}
	if results[0].event.CommandError != "compact_requires_active_run" {
		t.Errorf("CommandError = %q, want %q", results[0].event.CommandError, "compact_requires_active_run")
	}
	if results[0].event.EventMessage == "" {
		t.Errorf("expected informational EventMessage on compact_requires_active_run; got empty")
	}
}

// Compile-time assertion that ApiBackend satisfies compactable. If this
// stops compiling, the contract documented at compactable's declaration
// is broken — every CompactNow consumer needs to know.
var _ compactable = (*backend.ApiBackend)(nil)

// TestDispatchCompact_BindsRunIDForEventRouting is the regression test for the
// dropped-progress-events defect. The async compaction emits CompactingEvent
// under the synthetic runID user-compact-<convID>. During an idle /compact the
// session has no requestID, so unless dispatchCompact binds that runID to the
// key, keyForRun returns "" and handleNormalizedEvent DROPS the event — the
// desktop shows no "Compacting…" UI. This test holds a compaction in flight,
// drives a CompactingEvent through the backend's OnNormalized callback under
// the synthetic runID, and asserts it routes to the session key.
//
// Reverting the bindRunLocked call in dispatchCompact makes this test fail
// (the event is dropped, so the engine_compacting assertion never satisfies).
func TestDispatchCompact_BindsRunIDForEventRouting(t *testing.T) {
	mb := newCompactingMockBackend()
	mb.gate = make(chan struct{}) // hold compaction in flight
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-route", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["api-route"]
	s.conversationID = "conv-route"
	s.lastModel = "claude-sonnet-4-6"
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("api-route", "compact", "")

	// Wait for CompactNow to be invoked (compaction now in flight, gated).
	if !waitForCount(func() int { return mb.requestCount() }, 1) {
		t.Fatalf("timed out waiting for CompactNow to start")
	}

	// Simulate the backend emitting a CompactingEvent under the synthetic
	// runID, exactly as performCompact does. This drives the manager's
	// handleNormalizedEvent through the same OnNormalized callback the real
	// backend uses.
	runID := "user-compact-conv-route"
	mb.emitNormalized(runID, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})

	// The routed event must arrive as engine_compacting on the session key.
	if !waitForCount(func() int { return len(ec.byType("engine_compacting")) }, 1) {
		t.Fatalf("engine_compacting was not routed to the session key — runID binding missing (dropped-event regression)")
	}
	routed := ec.byType("engine_compacting")[0]
	if routed.key != "api-route" {
		t.Errorf("engine_compacting routed to key %q, want %q", routed.key, "api-route")
	}

	// Release the gate and let the goroutine finish so it doesn't leak.
	close(mb.gate)
	if !waitForCount(func() int { return len(ec.byType("engine_command_result")) }, 1) {
		t.Fatalf("timed out waiting for compaction to finish")
	}

	// After completion the binding must be gone (unbindRunLocked in finishCompact).
	mgr.mu.Lock()
	_, stillBound := mgr.runKeyBindings[runID]
	mgr.mu.Unlock()
	if stillBound {
		t.Errorf("runID binding %q should be cleared after compaction completes", runID)
	}
}

// TestDispatchCompact_RejectsConcurrentCompact verifies the double-run guard:
// a second /compact while one is in flight is rejected with
// compact_in_progress and does not launch a second CompactNow.
func TestDispatchCompact_RejectsConcurrentCompact(t *testing.T) {
	mb := newCompactingMockBackend()
	mb.gate = make(chan struct{})
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-dup", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["api-dup"]
	s.conversationID = "conv-dup"
	s.lastModel = "claude-sonnet-4-6"
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("api-dup", "compact", "") // first — goes in flight, gated

	if !waitForCount(func() int { return mb.requestCount() }, 1) {
		t.Fatalf("timed out waiting for first CompactNow to start")
	}

	// Second /compact while the first is gated in flight.
	mgr.SendCommand("api-dup", "compact", "")

	// The rejection is synchronous — a compact_in_progress result should land
	// without waiting for the first to finish.
	if !waitForCount(func() int {
		for _, e := range ec.byType("engine_command_result") {
			if e.event.CommandError == "compact_in_progress" {
				return 1
			}
		}
		return 0
	}, 1) {
		t.Fatalf("expected a compact_in_progress rejection for the concurrent /compact")
	}

	// Only ONE CompactNow was ever launched.
	if got := mb.requestCount(); got != 1 {
		t.Errorf("expected exactly 1 CompactNow call (second rejected), got %d", got)
	}

	close(mb.gate)
	// Drain the first's completion so the goroutine exits cleanly.
	_ = waitForCount(func() int {
		for _, e := range ec.byType("engine_command_result") {
			if e.event.CommandError == "" {
				return 1
			}
		}
		return 0
	}, 1)
}

// TestDispatchCompact_RejectsWhenRunActive verifies the compact-during-run
// guard: /compact is rejected with compact_requires_idle when a run is active
// (s.requestID != ""), rather than racing CompactNow against the run's own
// load-mutate-save of the same conversation.
func TestDispatchCompact_RejectsWhenRunActive(t *testing.T) {
	mb := newCompactingMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-busy", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["api-busy"]
	s.conversationID = "conv-busy"
	s.lastModel = "claude-sonnet-4-6"
	s.requestID = "run-in-flight" // simulate an active run
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("api-busy", "compact", "")

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 engine_command_result, got %d", len(results))
	}
	if results[0].event.CommandError != "compact_requires_idle" {
		t.Errorf("CommandError = %q, want %q", results[0].event.CommandError, "compact_requires_idle")
	}
	if got := mb.requestCount(); got != 0 {
		t.Errorf("expected no CompactNow call when a run is active, got %d", got)
	}
}

// TestDispatchCompact_EnqueuesPromptDuringCompaction verifies the symmetric
// guard direction: a prompt submitted while an async compaction is in flight
// is ENQUEUED (not dispatched into a clobbering run), and drained after the
// compaction completes. This is the run-during-compact half of the clobber
// race — SendPrompt's busy check consults s.compactInFlight because the
// synthetic compaction runID never sets s.requestID.
func TestDispatchCompact_EnqueuesPromptDuringCompaction(t *testing.T) {
	mb := newCompactingMockBackend()
	mb.gate = make(chan struct{})
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-queue", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["api-queue"]
	s.conversationID = "conv-queue"
	s.lastModel = "claude-sonnet-4-6"
	mgr.mu.Unlock()

	mgr.SendCommand("api-queue", "compact", "") // in flight, gated

	if !waitForCount(func() int { return mb.requestCount() }, 1) {
		t.Fatalf("timed out waiting for CompactNow to start")
	}

	// Submit a prompt while compaction is in flight. It must NOT start a run
	// (the mock's StartRun would record a call) — it must be queued.
	_ = mgr.SendPrompt("api-queue", "hello during compaction", nil)

	mgr.mu.Lock()
	queuedDepth := len(mgr.sessions["api-queue"].promptQueue)
	mgr.mu.Unlock()
	if queuedDepth != 1 {
		t.Fatalf("expected prompt to be enqueued during compaction; queue depth = %d", queuedDepth)
	}

	// Release the compaction. finishCompact clears compactInFlight and drains
	// the queued prompt, which SendPrompt then dispatches (mock StartRun).
	close(mb.gate)

	// Poll until the queued prompt has been drained (queue empty AND a run
	// started for it, i.e. requestID set by the drained SendPrompt).
	drained := func() bool {
		mgr.mu.Lock()
		defer mgr.mu.Unlock()
		sref := mgr.sessions["api-queue"]
		return len(sref.promptQueue) == 0 && !sref.compactInFlight && sref.requestID != ""
	}
	deadline := time.After(2 * time.Second)
	for !drained() {
		select {
		case <-deadline:
			t.Fatalf("queued prompt was not drained + dispatched after compaction completed")
		case <-time.After(2 * time.Millisecond):
		}
	}
}

// TestDispatchCompact_RootCtxCancellation verifies the async compaction runs
// under the session cancellation root: cancelling s.rootCtx (as SendAbort /
// StopSession do) aborts an in-flight CompactNow. The mock's gated CompactNow
// selects on ctx.Done(), so a cancelled root makes it return ctx.Err().
func TestDispatchCompact_RootCtxCancellation(t *testing.T) {
	mb := newCompactingMockBackend()
	mb.gate = make(chan struct{}) // never closed — only ctx cancellation frees it
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-cancel", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["api-cancel"]
	s.conversationID = "conv-cancel"
	s.lastModel = "claude-sonnet-4-6"
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)
	mgr.SendCommand("api-cancel", "compact", "")

	if !waitForCount(func() int { return mb.requestCount() }, 1) {
		t.Fatalf("timed out waiting for CompactNow to start")
	}

	// The captured context must be the session root (cancellable), not
	// context.Background().
	ctx := mb.capturedCtx()
	if ctx == nil {
		t.Fatalf("CompactNow captured a nil context")
	}
	if ctx == context.Background() {
		t.Fatalf("CompactNow ran under context.Background(); expected the cancellable session root")
	}

	// Cancel the session root, mirroring SendAbort / StopSession.
	mgr.mu.Lock()
	sref := mgr.sessions["api-cancel"]
	mgr.mu.Unlock()
	sref.cancelSessionRoot("test cancellation")

	// The gated CompactNow should observe ctx.Done() and return, so the
	// goroutine emits its result and finishCompact clears the flag.
	if !waitForCount(func() int { return len(ec.byType("engine_command_result")) }, 1) {
		t.Fatalf("cancelling the session root did not abort the in-flight compaction")
	}
	mgr.mu.Lock()
	stillInFlight := mgr.sessions["api-cancel"].compactInFlight
	mgr.mu.Unlock()
	if stillInFlight {
		t.Errorf("compactInFlight should be cleared after cancellation")
	}
}

// TestMockBackendsAreNotCompactable keeps the test architecture honest:
// dispatchCompact's CLI-fallback path must remain reachable from tests
// that exercise plain backends. If someone later adds CompactNow to one
// of these mocks, the CLI-path tests would silently start exercising
// the API path instead.
func TestMockBackendsAreNotCompactable(t *testing.T) {
	mb := newMockBackend()
	var i interface{} = mb
	if _, ok := i.(compactable); ok {
		t.Fatalf("mockBackend implements compactable; CLI-path tests cannot exercise the fallback. Add a non-compactable test stub.")
	}

	sb := newStdinCapturingBackend()
	i = sb
	if _, ok := i.(compactable); ok {
		t.Fatalf("stdinCapturingBackend implements compactable; CLI-path tests cannot exercise the fallback.")
	}
}
