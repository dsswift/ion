package session

import (
	"testing"
)

// TestHandleRunExit_CapturesCliSessionIDNotConversationID pins the
// two-identity-space contract for the CLI backend:
//
//   - The backend-reported sessionID (claude's native UUID) lands on
//     s.cliSessionID, which is the ONLY value fed to `claude --resume`.
//   - Ion's s.conversationID (the durable conversation-file identity) is
//     NEVER overwritten by the claude UUID — every Ion subsystem keyed on
//     the `{millis}-{hex}` id (compaction, export, /clear, tree navigation,
//     the client-facing session id) depends on it staying stable.
//   - A subsequent buildRunOptions carries CliResumeSessionID == <uuid> and
//     SessionID == <ion-id>.
func TestHandleRunExit_CapturesCliSessionIDNotConversationID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli-resume", defaultConfig())

	const ionConvID = "1781483744990-37463b20c27b"
	const claudeUUID = "11111111-2222-3333-4444-555555555555"

	// Seed the session as if StartSession pre-minted an Ion conversation id
	// and a run is in flight.
	mgr.mu.Lock()
	s := mgr.sessions["cli-resume"]
	s.conversationID = ionConvID
	s.requestID = "run-cli-resume"
	mgr.mu.Unlock()

	// Drive run exit with a claude-native UUID as the backend-reported
	// sessionID (mirrors CliBackend.emitExit on a successful first run).
	mgr.handleRunExit("run-cli-resume", intPtr(0), nil, claudeUUID)

	mgr.mu.RLock()
	gotCli := s.cliSessionID
	gotConv := s.conversationID
	mgr.mu.RUnlock()

	if gotCli != claudeUUID {
		t.Errorf("cliSessionID = %q, want %q (claude UUID must be captured for --resume)", gotCli, claudeUUID)
	}
	if gotConv != ionConvID {
		t.Errorf("conversationID = %q, want %q (Ion id must NOT be overwritten by the claude UUID)", gotConv, ionConvID)
	}

	// A follow-up prompt's RunOptions must resume with the claude UUID and
	// keep the Ion id as the conversation-file identity.
	opts := buildRunOptions(s, "next prompt", nil)
	if opts.CliResumeSessionID != claudeUUID {
		t.Errorf("buildRunOptions CliResumeSessionID = %q, want %q", opts.CliResumeSessionID, claudeUUID)
	}
	if opts.SessionID != ionConvID {
		t.Errorf("buildRunOptions SessionID = %q, want %q (Ion conversation-file id)", opts.SessionID, ionConvID)
	}
}

// TestBuildRunOptions_FirstRunOmitsCliResume verifies that before any CLI
// run has reported a UUID, buildRunOptions leaves CliResumeSessionID empty
// (so the CLI backend omits --resume) while still carrying the Ion id as
// SessionID.
func TestBuildRunOptions_FirstRunOmitsCliResume(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli-first", defaultConfig())

	const ionConvID = "1781483744990-aaaaaaaaaaaa"
	mgr.mu.Lock()
	s := mgr.sessions["cli-first"]
	s.conversationID = ionConvID
	// cliSessionID intentionally left empty — no run has completed yet.
	mgr.mu.Unlock()

	opts := buildRunOptions(s, "hello", nil)
	if opts.CliResumeSessionID != "" {
		t.Errorf("first run CliResumeSessionID = %q, want empty (no --resume on first CLI run)", opts.CliResumeSessionID)
	}
	if opts.SessionID != ionConvID {
		t.Errorf("first run SessionID = %q, want %q", opts.SessionID, ionConvID)
	}
}

// TestHandleRunExit_EmptySessionIDLeavesCliSessionIDUnchanged verifies that
// a run exit reporting no sessionID (e.g. an early failure before claude
// emitted SessionInitEvent) does not clobber a previously-captured UUID.
func TestHandleRunExit_EmptySessionIDLeavesCliSessionIDUnchanged(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli-empty", defaultConfig())

	const claudeUUID = "99999999-8888-7777-6666-555555555555"
	mgr.mu.Lock()
	s := mgr.sessions["cli-empty"]
	s.conversationID = "1781483744990-bbbbbbbbbbbb"
	s.cliSessionID = claudeUUID // captured on a prior run
	s.requestID = "run-cli-empty"
	mgr.mu.Unlock()

	mgr.handleRunExit("run-cli-empty", intPtr(1), nil, "")

	mgr.mu.RLock()
	got := s.cliSessionID
	mgr.mu.RUnlock()
	if got != claudeUUID {
		t.Errorf("cliSessionID = %q, want %q (empty reported sessionID must not clear a captured UUID)", got, claudeUUID)
	}
}

// TestHandleRunExit_IdleStatusReportsIonConversationID verifies that the
// run-exit engine_status carries Ion's conversationID (the stable
// client-facing id), never the backend-reported claude UUID.
func TestHandleRunExit_IdleStatusReportsIonConversationID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli-status", defaultConfig())
	ec := newEventCollector(mgr)

	const ionConvID = "1781483744990-cccccccccccc"
	const claudeUUID = "abcdabcd-1234-5678-9012-abcdefabcdef"
	mgr.mu.Lock()
	s := mgr.sessions["cli-status"]
	s.conversationID = ionConvID
	s.requestID = "run-cli-status"
	mgr.mu.Unlock()

	mgr.handleRunExit("run-cli-status", intPtr(0), nil, claudeUUID)

	// Find the idle engine_status emitted by handleRunExit.
	var idleSessionID string
	var found bool
	for _, ke := range ec.byType("engine_status") {
		ev := ke.event
		if ev.Fields != nil && ev.Fields.State == "idle" {
			idleSessionID = ev.Fields.SessionID
			found = true
		}
	}
	if !found {
		t.Fatal("no idle engine_status emitted by handleRunExit")
	}
	if idleSessionID != ionConvID {
		t.Errorf("idle engine_status SessionID = %q, want %q (Ion id, not claude UUID %q)", idleSessionID, ionConvID, claudeUUID)
	}
}
