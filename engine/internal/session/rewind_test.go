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
