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

	"github.com/dsswift/ion/engine/internal/backend"
)

// compactingMockBackend extends mockBackend with the compactable
// interface and records every CompactNow invocation so tests can
// assert what was passed in.
type compactingMockBackend struct {
	*mockBackend

	mu       sync.Mutex
	requests []backend.CompactRequest
	respond  func() error // returns the error CompactNow will report; nil = success
}

func newCompactingMockBackend() *compactingMockBackend {
	return &compactingMockBackend{mockBackend: newMockBackend()}
}

func (m *compactingMockBackend) CompactNow(_ context.Context, req backend.CompactRequest) error {
	m.mu.Lock()
	m.requests = append(m.requests, req)
	respond := m.respond
	m.mu.Unlock()
	if respond != nil {
		return respond()
	}
	return nil
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
// engine_command_result lands.
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
}

// TestDispatchCompact_APIPath_Error verifies that a CompactNow error
// surfaces in the engine_command_result as CommandError.
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
