package workspaces

// Schema-pinning tests: the engine reads the record the DESKTOP writes, and
// both sides fail open on mismatch — so a field rename on either side would
// silently disable the containment guard rather than fail anything. These
// tests load the shared fixture (testdata/worktree-registry.fixture.json, the
// desktop writer's current output shape) through the real Registry read path
// and assert every field the engine consumes decodes to its expected value.
// The desktop asserts the same fixture against its live writer
// (desktop/src/main/__tests__/workspace-record-parity.test.ts), so the
// fixture is the single source of truth and drift on either side goes red.

import (
	"os"
	"path/filepath"
	"testing"
)

// seedFixture copies a testdata fixture into a temp Ion dir under the name
// the engine actually reads, then returns a Registry over it — the REAL read
// path, not a parse shortcut.
func seedFixture(t *testing.T, fixtureName, recordName string) *Registry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", fixtureName))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, recordName), raw, 0o644); err != nil {
		t.Fatalf("seed record: %v", err)
	}
	return NewRegistryAt(dir)
}

func TestWorktreeRegistryFixtureDecodes(t *testing.T) {
	reg := seedFixture(t, "worktree-registry.fixture.json", "worktree-registry.json")

	entries := reg.Worktrees()
	// A silent fail-open yields an empty view — exactly the failure mode this
	// test exists to catch — so the count is the first assertion.
	if len(entries) != 2 {
		t.Fatalf("decoded %d entries from the fixture, want 2 (schema drift fails open)", len(entries))
	}

	first := entries[0]
	if first.WorktreePath != "/Users/dev/.ion/worktrees/project-aaaa1111" {
		t.Errorf("worktreePath = %q — the engine no longer reads the key the desktop writes", first.WorktreePath)
	}
	if first.RepoPath != "/Users/dev/source/project" {
		t.Errorf("repoPath = %q — the engine no longer reads the key the desktop writes", first.RepoPath)
	}
	// The descriptive fields are not load-bearing for containment, but workspace
	// CONTEXT states them as facts — and a fact the engine has to re-derive from
	// git is a fact it can get wrong. A rename here fails open silently, which is
	// exactly what this fixture exists to catch.
	if first.BranchName != "wt/project-aaaa1111" {
		t.Errorf("branchName = %q", first.BranchName)
	}
	if first.SourceBranch != "main" {
		t.Errorf("sourceBranch = %q", first.SourceBranch)
	}
	if first.Title != "fix the streaming retry loop" {
		t.Errorf("title = %q", first.Title)
	}
	if first.CreatedAt != 1700000000000 {
		t.Errorf("createdAt = %d", first.CreatedAt)
	}
	// The first entry has not landed; the second has. Landed changes what a
	// redirect to that worktree would mean, so both directions are pinned.
	if first.Landed() {
		t.Error("entry[0] has no landedAt and must not report as landed")
	}
	second := entries[1]
	if second.LandedAt != 1700000500000 {
		t.Errorf("landedAt = %d — the engine no longer reads the key the desktop writes", second.LandedAt)
	}
	if !second.Landed() {
		t.Error("entry[1] carries landedAt and must report as landed")
	}
}
