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
	// The bench branch is named in prompt context so an agent reading `git
	// status` recognizes the branch it is on as disposable.
	if b.BenchBranch != "ion/bench/main" {
		t.Errorf("benchBranch = %q", b.BenchBranch)
	}
	if b.LastBuiltAt != 1700000200000 {
		t.Errorf("lastBuiltAt = %d", b.LastBuiltAt)
	}
	// The assembly outcome decides whether the bench holds member content at
	// all. Reading it wrong means an agent draws conclusions from an empty tree.
	if b.LastAssembly != AssemblyAssembled {
		t.Errorf("lastAssembly = %q", b.LastAssembly)
	}
	if !b.Assembled() {
		t.Error("an 'assembled' record must report as assembled")
	}
	if b.AssemblyFailed() {
		t.Error("an 'assembled' record must not report as failed")
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
	// The tree hashes are the staleness axis. Compared as TREE hashes so an
	// amend (new sha, same tree) is not a false stale and a rebase (same sha
	// count, changed content) is not a missed one.
	if m.PinnedTreeHash != "fedcba9876543210fedcba9876543210fedcba98" {
		t.Errorf("member pinnedTreeHash = %q", m.PinnedTreeHash)
	}
	if m.CurrentTreeHash != "fedcba9876543210fedcba9876543210fedcba98" {
		t.Errorf("member currentTreeHash = %q", m.CurrentTreeHash)
	}
	if m.Pin != "current" {
		t.Errorf("member pin = %q", m.Pin)
	}
	if m.Merge != "merged" {
		t.Errorf("member merge = %q", m.Merge)
	}
	// Equal hashes: known and not stale. Both halves matter — an absent hash
	// must not read as freshness, which the second member covers below.
	if !m.StalenessKnown() {
		t.Error("member[0] carries both tree hashes, so freshness is knowable")
	}
	if m.Stale() {
		t.Error("member[0] has equal tree hashes and is not stale")
	}
	if m.PinnedRange() != "0123456789abcdef0123456789abcdef01234567..89abcdef0123456789abcdef0123456789abcdef" {
		t.Errorf("member pinnedRange = %q", m.PinnedRange())
	}
	if m.EmptyContribution() {
		t.Error("member[0] has differing base and tip and contributes work")
	}

	// The enabled pointer distinguishes explicit true/false from absent; the
	// fixture carries both values, and owner attribution depends on it.
	if !m.EnabledOrDefault() {
		t.Error("member[0] enabled=true decoded as disabled")
	}
	if b.Members[1].EnabledOrDefault() {
		t.Error("member[1] enabled=false decoded as enabled")
	}

	// The second member's hashes DIFFER: it is stale, and the bench holds work
	// its worktree has already moved past.
	if !b.Members[1].Stale() {
		t.Error("member[1] has differing tree hashes and must report as stale")
	}
	if b.Members[1].Pin != "behind" || b.Members[1].Merge != "skipped" {
		t.Errorf("member[1] pin/merge = %q/%q", b.Members[1].Pin, b.Members[1].Merge)
	}

	// The enabled/disabled split is what keeps disabled work from being
	// attributed as bench content.
	if len(b.EnabledMembers()) != 1 || b.EnabledMembers()[0].BranchName != "wt/project-aaaa1111" {
		t.Errorf("EnabledMembers = %+v", b.EnabledMembers())
	}
	if len(b.DisabledMembers()) != 1 || b.DisabledMembers()[0].BranchName != "wt/project-bbbb2222" {
		t.Errorf("DisabledMembers = %+v", b.DisabledMembers())
	}
}

// Absent optional keys must decode as UNKNOWN, never as a plausible default:
// an absent assembly outcome read as success, or an absent tree hash read as
// freshness, is a fact asserted from nothing.
func TestBenchRecordAbsentFieldsDecodeAsUnknown(t *testing.T) {
	dir := t.TempDir()
	raw := `{"version":1,"workspaces":[{"repoPath":"/repo","sourceBranch":"main","benchPath":"/bench","members":[{"worktreePath":"/wt/a","branchName":"wt/a"}]}]}`
	if err := os.WriteFile(filepath.Join(dir, "integration-workspaces.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	benches := NewRegistryAt(dir).Benches()
	if len(benches) != 1 {
		t.Fatalf("decoded %d workspaces, want 1", len(benches))
	}
	b := benches[0]

	if b.Assembled() || b.AssemblyFailed() {
		t.Error("an absent lastAssembly is neither assembled nor failed")
	}
	m := b.Members[0]
	if m.StalenessKnown() {
		t.Error("absent tree hashes mean freshness is UNKNOWN, not knowable")
	}
	if m.Stale() {
		t.Error("an absent hash must not report as stale either — unknown is unknown")
	}
	if m.PinnedRange() != "" {
		t.Errorf("no pins means no expressible range, got %q", m.PinnedRange())
	}
	if m.EmptyContribution() {
		t.Error("an absent pin pair is unknown, not an empty contribution")
	}
	// Absent enabled still means enrolled-and-included.
	if !m.EnabledOrDefault() {
		t.Error("absent enabled must default to enabled")
	}
}

// Unknown/new keys are ignored rather than failing the decode: the desktop
// writes a superset, and a field added on either side must never disturb the
// reader (which fails OPEN and would silently disable the guard).
func TestBenchRecordIgnoresUnknownFields(t *testing.T) {
	dir := t.TempDir()
	raw := `{"version":2,"futureTopLevel":{"x":1},"workspaces":[{"repoPath":"/repo","sourceBranch":"main","benchPath":"/bench","futureKey":"whatever","members":[{"worktreePath":"/wt/a","branchName":"wt/a","futureMemberKey":[1,2,3]}]}]}`
	if err := os.WriteFile(filepath.Join(dir, "integration-workspaces.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	benches := NewRegistryAt(dir).Benches()

	if len(benches) != 1 {
		t.Fatalf("unknown fields must not fail the decode, got %d workspaces", len(benches))
	}
	if benches[0].BenchPath != "/bench" || len(benches[0].Members) != 1 {
		t.Fatalf("known fields must still decode: %+v", benches[0])
	}
}

// MemberFor is how a bench-origin write decides whether its destination is an
// enrolled member at all.
func TestBenchMemberForMatchesSubdirectoriesOnly(t *testing.T) {
	b := BenchWorkspace{Members: []BenchMember{
		{WorktreePath: "/wt/alpha", BranchName: "wt/alpha"},
	}}

	if m := b.MemberFor("/wt/alpha/src/x.go"); m == nil || m.BranchName != "wt/alpha" {
		t.Fatalf("a path inside a member worktree must match it, got %+v", m)
	}
	if m := b.MemberFor("/wt/alpha"); m == nil {
		t.Fatal("the member root itself must match")
	}
	// A sibling whose path merely STARTS WITH a member's must not match, or the
	// permission would extend to an unrelated worktree.
	if m := b.MemberFor("/wt/alpha0/x.go"); m != nil {
		t.Fatalf("a prefix-sharing sibling must not match: %+v", m)
	}
}
