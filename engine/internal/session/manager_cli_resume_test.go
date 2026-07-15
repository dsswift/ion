package session

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// claudeCodeCaps is the descriptor a claude-code-served run records at
// dispatch; tests that drive handleRunExit directly (no SendPrompt) seed it
// onto the session the same way prompt_dispatch.go would have.
func claudeCodeCaps() backend.BackendCapabilities {
	return backend.NewClaudeCodeBackend().Capabilities()
}

// TestHandleRunExit_CapturesCursorNotConversationID pins the
// two-identity-space contract for the CLI backends:
//
//   - The backend-reported sessionID (claude's native UUID) lands on
//     s.nativeSessions[kind] as the cursor, which is the ONLY value fed to
//     `claude --resume` (via resolveCliContinuity → CliResumeSessionID).
//   - Ion's s.conversationID (the durable conversation-file identity) is
//     NEVER overwritten by the claude UUID — every Ion subsystem keyed on
//     the `{millis}-{hex}` id (compaction, export, /clear, tree navigation,
//     the client-facing session id) depends on it staying stable.
//   - The subsequent dispatch decision (resolveCliContinuity) resumes with
//     the captured cursor while buildRunOptions carries the Ion id.
func TestHandleRunExit_CapturesCursorNotConversationID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("cli-resume", defaultConfig())

	const ionConvID = "1781483744990-37463b20c27b"
	const claudeUUID = "11111111-2222-3333-4444-555555555555"

	// Seed the session as if StartSession pre-minted an Ion conversation id
	// and a claude-code run is in flight (prompt_dispatch recorded runCaps).
	mgr.mu.Lock()
	s := mgr.sessions["cli-resume"]
	s.conversationID = ionConvID
	s.requestID = "run-cli-resume"
	s.runCaps = claudeCodeCaps()
	mgr.mu.Unlock()

	// Drive run exit with a claude-native UUID as the backend-reported
	// sessionID (mirrors ClaudeCodeBackend.emitExit on a successful first run).
	mgr.handleRunExit("run-cli-resume", intPtr(0), nil, claudeUUID)

	mgr.mu.RLock()
	cursor, hasCursor := s.nativeSessions["claude-code"]
	gotConv := s.conversationID
	mgr.mu.RUnlock()

	if !hasCursor || cursor.Cursor != claudeUUID {
		t.Errorf("nativeSessions[claude-code].Cursor = %q (present=%v), want %q (claude UUID must be captured for --resume)", cursor.Cursor, hasCursor, claudeUUID)
	}
	if gotConv != ionConvID {
		t.Errorf("conversationID = %q, want %q (Ion id must NOT be overwritten by the claude UUID)", gotConv, ionConvID)
	}

	// buildRunOptions carries the Ion id and never the resume handle — the
	// resume decision belongs to resolveCliContinuity at dispatch.
	opts := buildRunOptions(s, "next prompt", nil)
	if opts.CliResumeSessionID != "" {
		t.Errorf("buildRunOptions CliResumeSessionID = %q, want empty (decision moved to resolveCliContinuity)", opts.CliResumeSessionID)
	}
	if opts.ConversationID != ionConvID {
		t.Errorf("buildRunOptions ConversationID = %q, want %q (Ion conversation-file id)", opts.ConversationID, ionConvID)
	}

	// The dispatch decision resumes with the captured cursor: the
	// conversation has no backing file (CLI-only), so the live leaf is ""
	// and matches the cursor's HeadEntryID captured at the same state.
	mgr.resolveCliContinuity(s, &opts)
	if opts.CliResumeSessionID != claudeUUID {
		t.Errorf("resolveCliContinuity CliResumeSessionID = %q, want %q", opts.CliResumeSessionID, claudeUUID)
	}
}

// TestBuildRunOptions_NeverCarriesCliResume verifies buildRunOptions leaves
// CliResumeSessionID empty unconditionally — the resume-vs-bridge decision is
// made at dispatch by resolveCliContinuity, after the model (and therefore
// the serving backend kind) is final.
func TestBuildRunOptions_NeverCarriesCliResume(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli-first", defaultConfig())

	const ionConvID = "1781483744990-aaaaaaaaaaaa"
	mgr.mu.Lock()
	s := mgr.sessions["cli-first"]
	s.conversationID = ionConvID
	s.nativeSessions = map[string]conversation.NativeSessionCursor{
		"claude-code": {Cursor: "some-uuid", HeadEntryID: ""},
	}
	mgr.mu.Unlock()

	opts := buildRunOptions(s, "hello", nil)
	if opts.CliResumeSessionID != "" {
		t.Errorf("CliResumeSessionID = %q, want empty (buildRunOptions never sets the resume handle)", opts.CliResumeSessionID)
	}
	if opts.ConversationID != ionConvID {
		t.Errorf("ConversationID = %q, want %q", opts.ConversationID, ionConvID)
	}
}

// TestHandleRunExit_EmptySessionIDLeavesCursorUnchanged verifies that a run
// exit reporting no sessionID (e.g. an early failure before claude emitted
// SessionInitEvent) does not clobber a previously-captured cursor.
func TestHandleRunExit_EmptySessionIDLeavesCursorUnchanged(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli-empty", defaultConfig())

	const claudeUUID = "99999999-8888-7777-6666-555555555555"
	mgr.mu.Lock()
	s := mgr.sessions["cli-empty"]
	s.conversationID = "1781483744990-bbbbbbbbbbbb"
	s.nativeSessions = map[string]conversation.NativeSessionCursor{
		"claude-code": {Cursor: claudeUUID, HeadEntryID: ""}, // captured on a prior run
	}
	s.requestID = "run-cli-empty"
	s.runCaps = claudeCodeCaps()
	mgr.mu.Unlock()

	mgr.handleRunExit("run-cli-empty", intPtr(1), nil, "")

	mgr.mu.RLock()
	got := s.nativeSessions["claude-code"].Cursor
	mgr.mu.RUnlock()
	if got != claudeUUID {
		t.Errorf("cursor = %q, want %q (empty reported sessionID must not clear a captured cursor)", got, claudeUUID)
	}
}

// TestHandleRunExit_IdleStatusReportsIonConversationID verifies that the
// run-exit engine_status carries Ion's conversationID (the stable
// client-facing id), never the backend-reported claude UUID.
func TestHandleRunExit_IdleStatusReportsIonConversationID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
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
	s.runCaps = claudeCodeCaps()
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

// TestHandleRunExit_DoesNotCaptureConversationIDAsCursor pins the guard
// that prevents the API backend from poisoning --resume. The ApiBackend
// reports sessionID == conversationID; capturing that as a cursor would
// later feed the Ion conversation id to `claude --resume` (or ThreadResume)
// when the conversation switches to a CLI backend — a resume id the CLI has
// never seen. Only a CLI-native id (distinct from the conversation id,
// reported by a native-session backend) is a valid resume handle.
func TestHandleRunExit_DoesNotCaptureConversationIDAsCursor(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-noresume", defaultConfig())

	const ionConvID = "1781483744990-cccccccccccc"
	mgr.mu.Lock()
	s := mgr.sessions["api-noresume"]
	s.conversationID = ionConvID
	s.requestID = "run-api-noresume"
	// Even with a (hypothetical) native-session descriptor recorded, the
	// id-equality guard must reject the conversation id as a cursor.
	s.runCaps = claudeCodeCaps()
	mgr.mu.Unlock()

	// The API backend reports sessionID == conversationID.
	mgr.handleRunExit("run-api-noresume", intPtr(0), nil, ionConvID)

	mgr.mu.RLock()
	_, hasCursor := s.nativeSessions["claude-code"]
	mgr.mu.RUnlock()

	if hasCursor {
		t.Error("cursor captured from sessionID == conversationID (the Ion conversation id must never become a CLI resume handle)")
	}
}

// TestHandleRunExit_EngineOwnedBackendDoesNotCapture pins the runCaps guard:
// a run served by an engine-owned backend (ApiBackend) never captures a
// cursor even when the backend reports a sessionID distinct from the
// conversation id.
func TestHandleRunExit_EngineOwnedBackendDoesNotCapture(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("api-owned", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["api-owned"]
	s.conversationID = "1781483744990-dddddddddddd"
	s.requestID = "run-api-owned"
	s.runCaps = backend.NewApiBackend().Capabilities() // engine_owned, Resume=false
	mgr.mu.Unlock()

	mgr.handleRunExit("run-api-owned", intPtr(0), nil, "some-distinct-id")

	mgr.mu.RLock()
	n := len(s.nativeSessions)
	mgr.mu.RUnlock()
	if n != 0 {
		t.Errorf("engine-owned run captured %d cursor(s), want 0", n)
	}
}

// TestNativeSessionCursor_CrossProviderFlow pins the whole flexibility story
// in sequence: a claude-code turn captures a cursor at the current head →
// the next same-provider turn resumes natively (no bridge) → an ApiBackend
// turn advances the transcript, staling the cursor → the next claude-code
// turn bridges from the transcript and re-captures at the new head → the
// turn after that resumes again. Correct by construction: staying on a
// provider is cheap native resume; switching providers re-bridges from truth.
func TestNativeSessionCursor_CrossProviderFlow(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const convID = "cross-provider-1"
	writeSeedConv(t, convID)

	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("xp-key", defaultConfig())
	mgr.mu.Lock()
	s := mgr.sessions["xp-key"]
	s.conversationID = convID
	mgr.mu.Unlock()

	// Turn 1 on claude-code: no cursor yet → bridge, then exit captures.
	opts1 := types.RunOptions{Model: "claude-opus-4-8", Prompt: "turn one"}
	mgr.resolveCliContinuity(s, &opts1)
	if opts1.CliResumeSessionID != "" {
		t.Fatalf("turn 1 must bridge (no cursor), got resume %q", opts1.CliResumeSessionID)
	}
	const uuid1 = "aaaaaaaa-0000-0000-0000-000000000001"
	mgr.captureNativeSessionCursor("xp-key", convID, "claude-code", uuid1)

	// Turn 2 on claude-code: cursor valid → native resume, no bridge.
	opts2 := types.RunOptions{Model: "claude-opus-4-8", Prompt: "turn two"}
	mgr.resolveCliContinuity(s, &opts2)
	if opts2.CliResumeSessionID != uuid1 {
		t.Fatalf("turn 2 must resume %q, got %q", uuid1, opts2.CliResumeSessionID)
	}
	if opts2.Prompt != "turn two" {
		t.Fatalf("turn 2 must not bridge: %q", opts2.Prompt)
	}

	// An ApiBackend turn advances the transcript — the intervening provider
	// moved the leaf, staling claude-code's cursor.
	advanceSeedConv(t, convID)

	// Turn 3 on claude-code: stale → bridge from truth, then re-capture.
	opts3 := types.RunOptions{Model: "claude-opus-4-8", Prompt: "turn three"}
	mgr.resolveCliContinuity(s, &opts3)
	if opts3.CliResumeSessionID != "" {
		t.Fatalf("turn 3 must bridge (stale cursor), got resume %q", opts3.CliResumeSessionID)
	}
	if !strings.Contains(opts3.Prompt, "intervening turn on another provider") {
		t.Fatalf("turn 3 bridge must carry the api-side turn: %q", opts3.Prompt)
	}
	const uuid2 = "bbbbbbbb-0000-0000-0000-000000000002"
	mgr.captureNativeSessionCursor("xp-key", convID, "claude-code", uuid2)

	// Turn 4 on claude-code: fresh cursor at the new head → resume again.
	opts4 := types.RunOptions{Model: "claude-opus-4-8", Prompt: "turn four"}
	mgr.resolveCliContinuity(s, &opts4)
	if opts4.CliResumeSessionID != uuid2 {
		t.Fatalf("turn 4 must resume the re-captured cursor %q, got %q", uuid2, opts4.CliResumeSessionID)
	}
	if opts4.Prompt != "turn four" {
		t.Fatalf("turn 4 must not bridge: %q", opts4.Prompt)
	}
}

// TestCaptureNativeSessionCursor_PersistsAndRehydrates pins the restart
// story end to end at the unit level: a capture on a conversation with a
// backing file persists the cursor into the .tree.jsonl header (tagged with
// the live leaf), a reload round-trips it, and rehydrateNativeSessions
// restores it onto a fresh session so the next same-provider turn resumes.
func TestCaptureNativeSessionCursor_PersistsAndRehydrates(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	leaf := writeSeedConv(t, "persist-conv-1")

	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("persist-key", defaultConfig())
	mgr.mu.Lock()
	s := mgr.sessions["persist-key"]
	s.conversationID = "persist-conv-1"
	mgr.mu.Unlock()

	const uuid = "cccccccc-1111-2222-3333-444444444444"
	mgr.captureNativeSessionCursor("persist-key", "persist-conv-1", "claude-code", uuid)

	// In-memory mirror updated, tagged with the live leaf.
	mgr.mu.RLock()
	got := s.nativeSessions["claude-code"]
	mgr.mu.RUnlock()
	if got.Cursor != uuid || got.HeadEntryID != leaf {
		t.Fatalf("in-memory cursor = %+v, want {%s %s}", got, uuid, leaf)
	}

	// Persisted: a fresh Load round-trips the cursor map.
	conv, err := conversation.Load("persist-conv-1", "")
	if err != nil {
		t.Fatalf("reload conv: %v", err)
	}
	persisted, ok := conv.NativeSessions["claude-code"]
	if !ok || persisted.Cursor != uuid || persisted.HeadEntryID != leaf {
		t.Fatalf("persisted cursor = %+v (present=%v), want {%s %s}", persisted, ok, uuid, leaf)
	}

	// Restart: a fresh session rehydrates the cursor and the next
	// same-provider dispatch resumes natively instead of re-bridging.
	s2 := &engineSession{key: "restarted", conversationID: "persist-conv-1"}
	mgr.rehydrateNativeSessions(s2, conv)
	opts := types.RunOptions{Model: "claude-opus-4-8", Prompt: "after restart"}
	mgr.resolveCliContinuity(s2, &opts)
	if opts.CliResumeSessionID != uuid {
		t.Fatalf("post-restart CliResumeSessionID = %q, want %q (resume, not re-bridge)", opts.CliResumeSessionID, uuid)
	}
	if opts.Prompt != "after restart" {
		t.Fatalf("post-restart prompt must be untouched on resume: %q", opts.Prompt)
	}
}
