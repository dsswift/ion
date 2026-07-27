package backend

import (
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

// Working-directory tracking on the conversation record.
//
// The engine persists `workingDirectory` in the conversation's tree header so a
// consumer reopening a stored conversation knows where it ran. The original
// implementation wrote that field ONLY when it was empty, which pinned the
// first-ever path forever. That is wrong for a conversation that legitimately
// MOVES: a consumer may relocate a live conversation to a different directory —
// for instance out of a git worktree that is being removed while the
// conversation continues — and the stale path then sends every later resume to
// a directory that no longer exists.
//
// These tests pin the corrected contract: the persisted directory tracks the
// run's project path, an absent project path never erases it, and the value
// survives a save/load round-trip so a reopened conversation resolves to the
// new location.

func TestSyncConversationWorkingDirectory_SeedsWhenEmpty(t *testing.T) {
	conv := conversation.CreateConversation("conv-seed", "", "test-model")
	if conv.WorkingDirectory != "" {
		t.Fatalf("precondition: fresh conversation should have no working directory, got %q", conv.WorkingDirectory)
	}

	changed := syncConversationWorkingDirectory(conv, "/repo/project", "run-1")

	if !changed {
		t.Error("expected changed=true when seeding an empty working directory")
	}
	if conv.WorkingDirectory != "/repo/project" {
		t.Errorf("WorkingDirectory = %q, want %q", conv.WorkingDirectory, "/repo/project")
	}
}

// The regression test for the relocation defect. On the unfixed code (which
// wrote only when the field was empty) the second call is a no-op and this
// fails: the conversation keeps the dead worktree path.
func TestSyncConversationWorkingDirectory_TracksRelocation(t *testing.T) {
	conv := conversation.CreateConversation("conv-move", "", "test-model")

	// First run inside a worktree.
	syncConversationWorkingDirectory(conv, "/worktrees/wt-a3f1", "run-1")
	if conv.WorkingDirectory != "/worktrees/wt-a3f1" {
		t.Fatalf("precondition: WorkingDirectory = %q, want the worktree path", conv.WorkingDirectory)
	}

	// The worktree is retired and the conversation is relocated to the repo
	// root; the next run carries the new project path.
	changed := syncConversationWorkingDirectory(conv, "/repo/project", "run-2")

	if !changed {
		t.Error("expected changed=true when the project path differs from the persisted one")
	}
	if conv.WorkingDirectory != "/repo/project" {
		t.Errorf("WorkingDirectory = %q, want %q — the conversation kept a stale path after relocation",
			conv.WorkingDirectory, "/repo/project")
	}
}

func TestSyncConversationWorkingDirectory_UnchangedWhenSame(t *testing.T) {
	conv := conversation.CreateConversation("conv-same", "", "test-model")
	conv.WorkingDirectory = "/repo/project"

	changed := syncConversationWorkingDirectory(conv, "/repo/project", "run-1")

	if changed {
		t.Error("expected changed=false when the project path already matches")
	}
	if conv.WorkingDirectory != "/repo/project" {
		t.Errorf("WorkingDirectory = %q, want it left alone", conv.WorkingDirectory)
	}
}

// An empty ProjectPath carries no information about where the conversation
// lives, so it must never erase a previously recorded directory.
func TestSyncConversationWorkingDirectory_EmptyPathPreservesExisting(t *testing.T) {
	conv := conversation.CreateConversation("conv-empty", "", "test-model")
	conv.WorkingDirectory = "/repo/project"

	changed := syncConversationWorkingDirectory(conv, "", "run-1")

	if changed {
		t.Error("expected changed=false for an empty project path")
	}
	if conv.WorkingDirectory != "/repo/project" {
		t.Errorf("WorkingDirectory = %q, want the existing value preserved", conv.WorkingDirectory)
	}
}

func TestSyncConversationWorkingDirectory_NilConversation(t *testing.T) {
	if syncConversationWorkingDirectory(nil, "/repo/project", "run-1") {
		t.Error("expected changed=false for a nil conversation")
	}
}

// End-to-end through persistence: the relocated directory must survive the
// save/load round-trip, because that is what a later resume actually reads.
func TestConversationWorkingDirectory_RelocationSurvivesRoundTrip(t *testing.T) {
	dir := t.TempDir()

	conv := conversation.CreateConversation("conv-roundtrip", "", "test-model")
	syncConversationWorkingDirectory(conv, filepath.Join(dir, "worktree"), "run-1")
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("save after first run: %v", err)
	}

	reloaded, err := conversation.Load("conv-roundtrip", dir)
	if err != nil {
		t.Fatalf("load after first run: %v", err)
	}
	if reloaded.WorkingDirectory != filepath.Join(dir, "worktree") {
		t.Fatalf("precondition: reloaded WorkingDirectory = %q, want the worktree path", reloaded.WorkingDirectory)
	}

	// Relocate and persist again.
	syncConversationWorkingDirectory(reloaded, filepath.Join(dir, "repo"), "run-2")
	if err := conversation.Save(reloaded, dir); err != nil {
		t.Fatalf("save after relocation: %v", err)
	}

	final, err := conversation.Load("conv-roundtrip", dir)
	if err != nil {
		t.Fatalf("load after relocation: %v", err)
	}
	if final.WorkingDirectory != filepath.Join(dir, "repo") {
		t.Errorf("persisted WorkingDirectory = %q, want %q — a resume would reopen the dead worktree path",
			final.WorkingDirectory, filepath.Join(dir, "repo"))
	}
}
