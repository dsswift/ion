package workspaces

import (
	"context"
	"testing"
)

func TestWorktreeList_OmitsMissingLandedWorktreesFromSiblingCwd(t *testing.T) {
	checker, repo, wtA, wtB := multiWorktreeFixture(t)
	_ = repo

	res := checker.WorktreeList(context.Background(), wtA)
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if len(res.Entries) != 1 {
		t.Fatalf("entries = %d, want only the live checkout: %+v", len(res.Entries), res.Entries)
	}

	a := &res.Entries[0]
	if a.WorktreePath != wtA {
		t.Fatalf("listed worktree = %q, want live checkout %q", a.WorktreePath, wtA)
	}
	if !a.IsSelf {
		t.Error("the entry matching the calling cwd must be IsSelf")
	}
	if !a.ExistsOnDisk {
		t.Error("every listed worktree must exist on disk")
	}
	if !a.UnlandedCountKnown || a.UnlandedCount != 2 {
		t.Errorf("wtA unlandedCount = %+v, want known=true count=2", a)
	}
	for _, entry := range res.Entries {
		if entry.WorktreePath == wtB {
			t.Fatalf("removed checkout %q must not remain in the worktree list", wtB)
		}
	}
}

func TestWorktreeList_FromBaseRepoListsAllWorktrees(t *testing.T) {
	checker, repo, wtA, wtB := multiWorktreeFixture(t)

	res := checker.WorktreeList(context.Background(), repo)
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if len(res.Entries) != 1 {
		t.Fatalf("entries from the base repo cwd = %d, want only the live checkout", len(res.Entries))
	}
	for _, e := range res.Entries {
		if e.IsSelf {
			t.Errorf("no entry is IsSelf when the caller is the base checkout, not a worktree: %+v", e)
		}
		if e.WorktreePath == wtB {
			t.Fatalf("removed checkout %q must not be listed from the base repo", wtB)
		}
	}
	_ = wtA
}

func TestWorktreeList_UnrelatedDirectoryIsRejected(t *testing.T) {
	checker, _, _, _ := multiWorktreeFixture(t)

	res := checker.WorktreeList(context.Background(), t.TempDir())
	if res.Rejection == "" {
		t.Fatal("an unrelated directory must be rejected, not silently empty-listed")
	}
	if len(res.Entries) != 0 {
		t.Errorf("a rejected query must return no entries, got %+v", res.Entries)
	}
}

func TestWorktreeList_NilCheckerIsRejected(t *testing.T) {
	var c *Checker
	res := c.WorktreeList(context.Background(), "/anything")
	if res.Rejection == "" {
		t.Error("a nil checker must reject rather than panic or silently succeed")
	}
}
