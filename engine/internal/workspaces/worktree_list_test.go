package workspaces

import (
	"context"
	"testing"
)

func TestWorktreeList_ListsGroupFromSiblingCwd(t *testing.T) {
	checker, repo, wtA, wtB := multiWorktreeFixture(t)
	_ = repo

	res := checker.WorktreeList(context.Background(), wtA)
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if len(res.Entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(res.Entries))
	}

	var a, b *WorktreeListEntry
	for i := range res.Entries {
		switch res.Entries[i].WorktreePath {
		case wtA:
			a = &res.Entries[i]
		case wtB:
			b = &res.Entries[i]
		}
	}
	if a == nil || b == nil {
		t.Fatalf("expected both wtA and wtB in entries, got %+v", res.Entries)
	}

	if !a.IsSelf {
		t.Error("the entry matching the calling cwd must be IsSelf")
	}
	if b.IsSelf {
		t.Error("a sibling entry must not be IsSelf")
	}
	if !a.ExistsOnDisk {
		t.Error("wtA still exists on disk and must report ExistsOnDisk=true")
	}
	if b.ExistsOnDisk {
		t.Error("wtB was removed from disk and must report ExistsOnDisk=false")
	}

	// wtA has 2 commits ahead of main; wtB has 1 -- and its branch is still
	// readable via the shared object store even though its directory is gone.
	if !a.UnlandedCountKnown || a.UnlandedCount != 2 {
		t.Errorf("wtA unlandedCount = %+v, want known=true count=2", a)
	}
	if !b.UnlandedCountKnown || b.UnlandedCount != 1 {
		t.Errorf("wtB unlandedCount = %+v, want known=true count=1 (readable despite removed checkout)", b)
	}
	if b.HeadSha == "" || b.HeadSubject != "wt/b commit 1" {
		t.Errorf("wtB head summary = %+v, want a resolvable sha and subject from the shared object store", b)
	}
}

func TestWorktreeList_FromBaseRepoListsAllWorktrees(t *testing.T) {
	checker, repo, wtA, wtB := multiWorktreeFixture(t)

	res := checker.WorktreeList(context.Background(), repo)
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if len(res.Entries) != 2 {
		t.Fatalf("entries from the base repo cwd = %d, want 2", len(res.Entries))
	}
	for _, e := range res.Entries {
		if e.IsSelf {
			t.Errorf("no entry is IsSelf when the caller is the base checkout, not a worktree: %+v", e)
		}
	}
	_ = wtA
	_ = wtB
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
