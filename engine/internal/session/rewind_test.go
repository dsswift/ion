package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// seedRewindConv builds a persisted conversation shaped U1, plan-marker(x), U2,
// assistant, and returns the convID. The plan file for marker x is written to
// disk so the restore path's os.Stat guard passes.
func seedRewindConv(t *testing.T, key, planPath string) string {
	t.Helper()
	convID := "rewind-conv-" + key
	conv := conversation.CreateConversation(convID, "system", "test-model")
	conversation.AddUserMessage(conv, "first")
	conversation.AppendEntry(conv, conversation.EntryPlanMarker, conversation.PlanMarkerData{
		Operation: "created", PlanFilePath: planPath, PlanSlug: "x",
	})
	conversation.AddUserMessage(conv, "second")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "resp"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}
	return convID
}

// TestRewindSession_BranchesAndRestoresPlan pins the whole rewind: the leaf moves
// to before the target turn (context truncates, no duplicate) AND the session's
// plan-file continuity is restored from the tree to the plan in effect at that
// point.
func TestRewindSession_BranchesAndRestoresPlan(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	planPath := filepath.Join(tempHome, "plans", "x.md")
	if err := os.MkdirAll(filepath.Dir(planPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(planPath, []byte("# plan x"), 0o644); err != nil {
		t.Fatal(err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "rewind-plan-restore"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := seedRewindConv(t, key, planPath)
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.planFilePath = "/gone/y.md" // simulate a later plan the rewind must discard
	mgr.mu.Unlock()

	// Rewind to before the 2nd user turn (ordinal 1).
	if err := mgr.RewindSession(key, 1); err != nil {
		t.Fatalf("RewindSession: %v", err)
	}

	// Context truncated: only the first turn survives on the active path.
	convDir := filepath.Join(tempHome, ".ion", "conversations")
	loaded, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(loaded.Messages) != 1 {
		t.Fatalf("after rewind, context = %d messages, want 1 (first turn only)", len(loaded.Messages))
	}

	// Plan continuity restored to marker x (not the discarded /gone/y.md).
	mgr.mu.RLock()
	got := mgr.sessions[key].planFilePath
	mgr.mu.RUnlock()
	if got != planPath {
		t.Fatalf("session planFilePath = %q, want %q", got, planPath)
	}
}

// TestRewindSession_FirstTurnClearsPlan pins that rewinding before any plan marker
// clears the session's plan file (nothing to restore to).
func TestRewindSession_FirstTurnClearsPlan(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	planPath := filepath.Join(tempHome, "plans", "x.md")
	_ = os.MkdirAll(filepath.Dir(planPath), 0o755)
	_ = os.WriteFile(planPath, []byte("# plan x"), 0o644)

	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "rewind-first-clears"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := seedRewindConv(t, key, planPath)
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.planFilePath = planPath
	mgr.mu.Unlock()

	if err := mgr.RewindSession(key, 0); err != nil {
		t.Fatalf("RewindSession: %v", err)
	}

	mgr.mu.RLock()
	got := mgr.sessions[key].planFilePath
	mgr.mu.RUnlock()
	if got != "" {
		t.Fatalf("session planFilePath = %q, want empty after rewind before any plan", got)
	}
}

// TestRewindSession_OutOfRange pins that an ordinal past the last user turn is an
// error, not a silent no-op.
func TestRewindSession_OutOfRange(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "rewind-oob"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := seedRewindConv(t, key, filepath.Join(t.TempDir(), "x.md"))
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	if err := mgr.RewindSession(key, 5); err == nil {
		t.Fatalf("expected out-of-range error for ordinal 5")
	}
}

// TestBranchSession_ReturnsErrorOnUnknownEntry pins the swallowed-error fix:
// BranchSession must surface a branch failure instead of logging and returning
// nil (which left a rewind silently unapplied).
func TestBranchSession_ReturnsErrorOnUnknownEntry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "branch-err"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := seedRewindConv(t, key, filepath.Join(t.TempDir(), "x.md"))
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	if err := mgr.BranchSession(key, "does-not-exist"); err == nil {
		t.Fatalf("expected error branching to unknown entry, got nil")
	}
}

// TestRewindSessionToEntry_ExactMatch pins the exact-entry-addressed rewind
// path: given the real entry id of the 2nd user turn (resolved the same way a
// client would learn it, via UserMessageEntryID), RewindSessionToEntry
// branches to the same point RewindSession(key, 1) would reach by ordinal.
// This is the regression test for the identity-vs-ordinal defect: a client
// that retained an exact EntryID from a prior engine_steer_injected
// confirmation must be able to rewind to precisely that turn without
// recomputing (and potentially mis-deriving) an ordinal.
func TestRewindSessionToEntry_ExactMatch(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	planPath := filepath.Join(tempHome, "plans", "x.md")
	if err := os.MkdirAll(filepath.Dir(planPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(planPath, []byte("# plan x"), 0o644); err != nil {
		t.Fatal(err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "rewind-exact-match"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := seedRewindConv(t, key, planPath)
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	mgr.mu.Unlock()

	convDir := filepath.Join(tempHome, ".ion", "conversations")
	loaded, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	entryID, found := conversation.UserMessageEntryID(loaded, 1)
	if !found {
		t.Fatal("expected to resolve entry id for user turn 1")
	}

	if err := mgr.RewindSessionToEntry(key, entryID); err != nil {
		t.Fatalf("RewindSessionToEntry: %v", err)
	}

	reloaded, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(reloaded.Messages) != 1 {
		t.Fatalf("after exact-entry rewind, context = %d messages, want 1 (first turn only)", len(reloaded.Messages))
	}

	mgr.mu.RLock()
	got := mgr.sessions[key].planFilePath
	mgr.mu.RUnlock()
	if got != planPath {
		t.Fatalf("session planFilePath = %q, want %q", got, planPath)
	}
}

// TestRewindSessionToEntry_RejectsUnknownEntry pins that an entry id with no
// match on the current path is rejected loudly rather than silently branching
// (or panicking) — the exact-entry validation gate must run BEFORE
// BranchBefore, which has no independent notion of "is this a real entry".
func TestRewindSessionToEntry_RejectsUnknownEntry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "rewind-exact-unknown"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := seedRewindConv(t, key, filepath.Join(t.TempDir(), "x.md"))
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	if err := mgr.RewindSessionToEntry(key, "does-not-exist"); err == nil {
		t.Fatalf("expected error rewinding to unknown entry id, got nil")
	}
}

// TestRewindSessionToEntry_RejectsNonUserEntry pins that an entry id naming a
// real but non-user row (the assistant turn seeded by seedRewindConv) is
// rejected. A client must never be able to rewind "before" an assistant
// response by exact id — only a genuine user turn is a valid rewind target,
// mirroring the ordinal path's implicit guarantee (UserMessageEntryID only
// ever returns ids for role=="user" rows).
func TestRewindSessionToEntry_RejectsNonUserEntry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "rewind-exact-non-user"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := seedRewindConv(t, key, filepath.Join(t.TempDir(), "x.md"))
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	loaded, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// The conversation's leaf entry is the assistant response appended last by
	// seedRewindConv. Its own id is not a user row.
	if loaded.LeafID == nil {
		t.Fatal("expected a non-nil leaf id in seeded conversation")
	}
	assistantEntryID := *loaded.LeafID

	if err := mgr.RewindSessionToEntry(key, assistantEntryID); err == nil {
		t.Fatalf("expected error rewinding to a non-user entry id, got nil")
	}
}
