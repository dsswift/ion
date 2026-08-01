package workspaces

// Schema-pinning tests: the engine reads records the DESKTOP writes, and both
// sides fail open on mismatch — so a field rename on either side would
// silently disable the containment guard rather than fail anything. These
// tests load the shared fixtures (testdata/*.fixture.json, the desktop
// writers' current output shape) through the real Registry read path and
// assert every field the engine consumes decodes to its expected value. The
// desktop asserts the same fixtures against its live writers
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
}

func TestIntegrationWorkspacesFixtureDecodes(t *testing.T) {
	reg := seedFixture(t, "integration-workspaces.fixture.json", "integration-workspaces.json")

	benches := reg.Benches()
	if len(benches) != 1 {
		t.Fatalf("decoded %d workspaces from the fixture, want 1 (schema drift fails open)", len(benches))
	}

	b := benches[0]
	if b.BenchPath != "/Users/dev/.ion/integration/project-main" {
		t.Errorf("benchPath = %q", b.BenchPath)
	}
	if b.RepoPath != "/Users/dev/source/project" {
		t.Errorf("repoPath = %q", b.RepoPath)
	}
	if b.SourceBranch != "main" {
		t.Errorf("sourceBranch = %q", b.SourceBranch)
	}
	if b.BaseSha != "0123456789abcdef0123456789abcdef01234567" {
		t.Errorf("baseSha = %q", b.BaseSha)
	}

	if len(b.Members) != 2 {
		t.Fatalf("decoded %d members, want 2", len(b.Members))
	}
	m := b.Members[0]
	if m.WorktreePath != "/Users/dev/.ion/worktrees/project-aaaa1111" {
		t.Errorf("member worktreePath = %q", m.WorktreePath)
	}
	if m.BranchName != "wt/project-aaaa1111" {
		t.Errorf("member branchName = %q", m.BranchName)
	}
	if m.PinnedSha != "89abcdef0123456789abcdef0123456789abcdef" {
		t.Errorf("member pinnedSha = %q", m.PinnedSha)
	}
	if m.PinnedBase != "0123456789abcdef0123456789abcdef01234567" {
		t.Errorf("member pinnedBaseSha = %q", m.PinnedBase)
	}
	// The enabled pointer distinguishes explicit true/false from absent; the
	// fixture carries both values, and owner attribution depends on it.
	if !m.EnabledOrDefault() {
		t.Error("member[0] enabled=true decoded as disabled")
	}
	if b.Members[1].EnabledOrDefault() {
		t.Error("member[1] enabled=false decoded as enabled")
	}
}
