package session

import (
	"regexp"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

var w3cTraceID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// traceIDForRun pulls the trace ID off the context the manager threaded onto
// the run's RunOptions. This is the value every utils.LogCtx call beneath the
// run stamps as trace_id, so asserting here asserts the whole run's log
// correlation in one place.
func traceIDForRun(t *testing.T, mb *mockBackend, requestID string) string {
	t.Helper()
	mb.mu.Lock()
	opts, ok := mb.started[requestID]
	mb.mu.Unlock()
	if !ok {
		t.Fatalf("backend never saw run %q", requestID)
	}
	if opts.ParentCtx == nil {
		t.Fatalf("run %q dispatched with no ParentCtx; trace id cannot ride to the backend", requestID)
	}
	return utils.TraceIDFromContext(opts.ParentCtx)
}

// TestRunTraceIDIsPerRun is the core regression test for run-scoped tracing.
//
// RED on the unfixed code: the trace ID was minted once per session in
// newSessionRootContext and threaded onto the session root, so both runs below
// observed the SAME trace ID and the second assertion failed. A trace that
// spans every run in a session is unusable as an APM operation id — the whole
// reason for the change.
func TestRunTraceIDIsPerRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "trace-per-run"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if err := mgr.SendPrompt(key, "first", nil); err != nil {
		t.Fatalf("SendPrompt 1: %v", err)
	}
	mgr.mu.Lock()
	firstRunID := mgr.sessions[key].requestID
	firstTrace := mgr.sessions[key].runTraceID
	mgr.mu.Unlock()

	// End the first run so the session accepts the next prompt, exactly as a
	// real run exit would.
	mgr.handleRunExit(firstRunID, intPtr(0), nil, "")

	if err := mgr.SendPrompt(key, "second", nil); err != nil {
		t.Fatalf("SendPrompt 2: %v", err)
	}
	mgr.mu.Lock()
	secondRunID := mgr.sessions[key].requestID
	secondTrace := mgr.sessions[key].runTraceID
	mgr.mu.Unlock()

	for name, id := range map[string]string{"first": firstTrace, "second": secondTrace} {
		if !w3cTraceID.MatchString(id) {
			t.Errorf("%s run trace id = %q, want 32 lowercase hex chars (W3C trace-context)", name, id)
		}
	}
	if firstRunID == secondRunID {
		t.Fatalf("test setup: both runs share requestID %q", firstRunID)
	}
	if firstTrace == secondTrace {
		t.Errorf("both runs share trace id %q; trace scope must be the run, not the session", firstTrace)
	}

	// The same per-run value must reach the backend on the run context, which
	// is what makes every log line beneath the run carry it.
	if got := traceIDForRun(t, mb, firstRunID); got != firstTrace {
		t.Errorf("run 1 ParentCtx trace id = %q, want %q", got, firstTrace)
	}
	if got := traceIDForRun(t, mb, secondRunID); got != secondTrace {
		t.Errorf("run 2 ParentCtx trace id = %q, want %q", got, secondTrace)
	}
}

// TestRunTraceIDClearedOnRunExit pins that the trace ends with the run. A
// lingering trace ID would be stamped onto lines emitted between runs, falsely
// attributing them to a transaction that already finished.
func TestRunTraceIDClearedOnRunExit(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "trace-cleared"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if err := mgr.SendPrompt(key, "only", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	mgr.mu.Lock()
	runID := mgr.sessions[key].requestID
	during := mgr.sessions[key].runTraceID
	mgr.mu.Unlock()
	if during == "" {
		t.Fatal("expected a trace id while the run is in flight")
	}

	mgr.handleRunExit(runID, intPtr(0), nil, "")

	mgr.mu.Lock()
	after := mgr.sessions[key].runTraceID
	mgr.mu.Unlock()
	if after != "" {
		t.Errorf("trace id = %q after run exit, want empty: the trace ends with the run", after)
	}
}

// TestSessionRootCarriesNoTraceID pins the deliberate omission. Lines emitted
// outside any run (session start/stop) carry no trace_id because no
// transaction is in flight; they stay joinable by session_id and
// conversation_id. RED on the unfixed code, which stamped a session-scoped
// trace ID onto the root context.
func TestSessionRootCarriesNoTraceID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "trace-root-clean"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	root := mgr.sessions[key].rootContext()
	mgr.mu.Unlock()

	if got := utils.TraceIDFromContext(root); got != "" {
		t.Errorf("session root context carries trace id %q; trace scope is the run, so the root must carry none", got)
	}
	if got := utils.SessionIDFromContext(root); got != key {
		t.Errorf("session root session_id = %q, want %q (session-scoped IDs stay on the root)", got, key)
	}
}
