package session

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// A delegated-CLI dispatch pre-persists its accepted user turn (run recovery)
// BEFORE the resume-vs-bridge decision runs, so the conversation leaf at
// decision time is the dispatch's own entry. Judging cursor staleness against
// that leaf made every dispatch stale itself: the cursor was discarded, the
// entire transcript was bridged into a fresh subprocess, and the delegated CLI
// never resumed — so it never accumulated a native session it could compact.
//
// continuityLeaf discounts exactly that one entry. These arms pin the three
// outcomes that distinguish the fix from both the bug and an over-correction.

// seedResumeConversation writes a conversation with one completed turn and a
// cursor captured at its leaf, then appends the entry a dispatch would
// pre-persist. Returns the cursor's leaf and the pre-persisted entry ID.
func seedResumeConversation(t *testing.T, convID, cursor string) (cursorLeaf, prePersistedID string) {
	t.Helper()
	conv := conversation.CreateConversation(convID, "", "claude-sonnet-4-6")
	conversation.AddUserMessage(conv, "earlier turn")
	conversation.AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "text", Text: "earlier reply"}}, "claude-sonnet-4-6")
	cursorLeaf = conversation.CurrentLeafID(conv)
	conv.NativeSessions = map[string]conversation.NativeSessionCursor{
		"claude-code": {Cursor: cursor, HeadEntryID: cursorLeaf},
	}
	// The run-recovery write this same dispatch performs before the decision.
	prePersisted := conversation.AddUserMessage(conv, "the new prompt")
	if prePersisted == nil {
		t.Fatal("AddUserMessage returned no entry")
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	return cursorLeaf, prePersisted.ID
}

func seedResumeSession(t *testing.T, mgr *Manager, key, convID, cursor, cursorLeaf string) *engineSession {
	t.Helper()
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.nativeSessions = map[string]conversation.NativeSessionCursor{
		"claude-code": {Cursor: cursor, HeadEntryID: cursorLeaf},
	}
	mgr.mu.Unlock()
	return s
}

// TestResolveCliContinuity_ResumesAcrossOwnPrePersistedTurn is the regression
// arm: with the dispatch's own pre-persisted user entry named, the cursor is
// still valid and the run resumes natively instead of re-bridging.
func TestResolveCliContinuity_ResumesAcrossOwnPrePersistedTurn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID, cursor = "resume-prepersisted", "1784000000001-aaaaaaaaaaaa", "native-uuid-1"
	cursorLeaf, prePersistedID := seedResumeConversation(t, convID, cursor)
	s := seedResumeSession(t, mgr, key, convID, cursor, cursorLeaf)

	opts := types.RunOptions{Model: "claude-sonnet-4-6", Prompt: "the new prompt", PrePersistedUserEntryID: prePersistedID}
	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != cursor {
		t.Errorf("CliResumeSessionID = %q, want %q (cursor must survive this dispatch's own pre-persisted user entry)", opts.CliResumeSessionID, cursor)
	}
	if opts.Prompt != "the new prompt" {
		t.Errorf("Prompt was bridged on a resumable turn: %q", opts.Prompt)
	}
}

// TestResolveCliContinuity_BridgesWhenNoPrePersistedTurn pins that the
// discount is opt-in: a dispatch that names no pre-persisted entry compares
// against the raw live leaf and bridges, which is the pre-fix behaviour and
// the behaviour a recovery continuation still needs.
func TestResolveCliContinuity_BridgesWhenNoPrePersistedTurn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID, cursor = "resume-nodiscount", "1784000000002-bbbbbbbbbbbb", "native-uuid-2"
	cursorLeaf, _ := seedResumeConversation(t, convID, cursor)
	s := seedResumeSession(t, mgr, key, convID, cursor, cursorLeaf)

	opts := types.RunOptions{Model: "claude-sonnet-4-6", Prompt: "the new prompt"}
	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "" {
		t.Errorf("CliResumeSessionID = %q, want empty (live leaf moved, cursor is stale)", opts.CliResumeSessionID)
	}
	if !strings.Contains(opts.Prompt, "<prior-conversation>") {
		t.Errorf("expected a bridged transcript, got %q", opts.Prompt)
	}
}

// TestResolveCliContinuity_StillBridgesWhenAnotherWriterAdvancedLeaf pins the
// over-correction: discounting the dispatch's own entry must not blind the
// check to a leaf some OTHER writer moved. Here a second entry sits after the
// pre-persisted one, so the continuity leaf is not the cursor's head and the
// run must re-bridge from Ion's transcript.
func TestResolveCliContinuity_StillBridgesWhenAnotherWriterAdvancedLeaf(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID, cursor = "resume-otherwriter", "1784000000003-cccccccccccc", "native-uuid-3"
	cursorLeaf, prePersistedID := seedResumeConversation(t, convID, cursor)

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	conversation.AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "text", Text: "a turn from another provider"}}, "gpt-5")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	s := seedResumeSession(t, mgr, key, convID, cursor, cursorLeaf)

	opts := types.RunOptions{Model: "claude-sonnet-4-6", Prompt: "the new prompt", PrePersistedUserEntryID: prePersistedID}
	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "" {
		t.Errorf("CliResumeSessionID = %q, want empty (another writer advanced the leaf)", opts.CliResumeSessionID)
	}
	if !strings.Contains(opts.Prompt, "<prior-conversation>") {
		t.Errorf("expected a bridged transcript, got %q", opts.Prompt)
	}
}
