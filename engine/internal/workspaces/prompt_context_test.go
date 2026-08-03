package workspaces

// Workspace prompt context: the structured facts and the generic formatter.
//
// The property under test throughout is that the STRUCT is the contract. A
// consumer that wants different prose reads the struct, so every fact the
// formatter renders must be present as a field — and no fact may exist only in
// the prose, where a consumer cannot reach it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeBenchRecord(t *testing.T, dir string, workspaces ...map[string]any) {
	t.Helper()
	payload := map[string]any{"version": 1, "workspaces": workspaces}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "integration-workspaces.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// ─── Plain directories produce nothing ───────────────────────────────────────

func TestPromptContextIsEmptyOutsideAnyWorkspace(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor("/somewhere/unrelated")

	if !ctx.Empty() {
		t.Fatalf("a plain directory must produce no context, got %+v", ctx)
	}
	if ctx.Format() != "" {
		t.Fatalf("an empty context must format to nothing so callers can inject unconditionally, got %q", ctx.Format())
	}
}

func TestPromptContextIsEmptyForNilCheckerAndEmptyCwd(t *testing.T) {
	var nilChecker *Checker
	if !nilChecker.PromptContextFor("/wt/a").Empty() {
		t.Error("a nil checker is the disabled state and must produce no context")
	}
	c := NewCheckerAt(t.TempDir())
	if !c.PromptContextFor("").Empty() {
		t.Error("an empty cwd must produce no context")
	}
}

// ─── Worktree context ────────────────────────────────────────────────────────

func TestPromptContextDescribesWorktree(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath, BranchName: "wt/mine",
			SourceBranch: "main", Title: "fix the streaming retry loop"},
		{WorktreePath: sibling, RepoPath: repoPath, BranchName: "wt/other", Title: "unrelated work"},
	})
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor(minePath)

	if ctx.Kind != ContextWorktree {
		t.Fatalf("kind = %q, want worktree", ctx.Kind)
	}
	if ctx.Worktree == nil {
		t.Fatal("worktree context must be populated when kind is worktree")
	}
	w := ctx.Worktree
	if w.BranchName != "wt/mine" || w.SourceBranch != "main" {
		t.Errorf("branch/source not carried: %+v", w)
	}
	if w.Title != "fix the streaming retry loop" {
		t.Errorf("title not carried: %q", w.Title)
	}
	if len(w.Siblings) != 1 || w.Siblings[0].WorktreePath != sibling {
		t.Fatalf("siblings = %+v, want exactly the same-repo sibling", w.Siblings)
	}
	if w.Siblings[0].Title != "unrelated work" {
		t.Errorf("the sibling's title must come from its own registry entry: %q", w.Siblings[0].Title)
	}

	// The prose must state the invariant the engine actually enforces, since
	// that is the half a model can act on.
	prose := ctx.Format()
	for _, want := range []string{minePath, repoPath, "wt/mine", sibling, "refused"} {
		if !strings.Contains(prose, want) {
			t.Errorf("formatted context must mention %q:\n%s", want, prose)
		}
	}
}

// A worktree that is a bench member is told so: its work is being integrated
// elsewhere, and only a pin update carries a commit into that bench.
func TestPromptContextNamesBenchesTheWorktreeIsEnrolledIn(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath, BranchName: "wt/mine"},
	})
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"members": []map[string]any{{"worktreePath": minePath, "branchName": "wt/mine"}},
	})
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor(minePath)

	if len(ctx.Worktree.BenchPaths) != 1 || ctx.Worktree.BenchPaths[0] != "/bench/project-main" {
		t.Fatalf("benchPaths = %v, want the enrolling bench", ctx.Worktree.BenchPaths)
	}
	if !strings.Contains(ctx.Format(), "PINNED") {
		t.Errorf("the prose must explain that a bench integrates the pin, not the tip:\n%s", ctx.Format())
	}
}

func TestPromptContextReportsLandedWorktree(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath, LandedAt: 1700000500000},
	})
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor(minePath)

	if !ctx.Worktree.Landed {
		t.Fatal("a worktree with landedAt set must report as landed")
	}
	if !strings.Contains(ctx.Format(), "already landed") {
		t.Errorf("the prose must state that the work landed:\n%s", ctx.Format())
	}
}

// ─── Bench context ───────────────────────────────────────────────────────────

func TestPromptContextDescribesBenchWithOrderedEnabledMembers(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: "/wt/first", RepoPath: repoPath, Title: "first worktree"},
		{WorktreePath: "/wt/second", RepoPath: repoPath, Title: "second worktree"},
	})
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"benchBranch": "ion/bench/main", "baseSha": "aaaa1111", "lastAssembly": "assembled",
		"members": []map[string]any{
			{"worktreePath": "/wt/first", "branchName": "wt/first", "enabled": true,
				"pinnedSha": "1111", "pinnedBaseSha": "aaaa1111", "pin": "current", "merge": "merged",
				"pinnedTreeHash": "tree1", "currentTreeHash": "tree1"},
			{"worktreePath": "/wt/second", "branchName": "wt/second", "enabled": true,
				"pinnedSha": "2222", "pinnedBaseSha": "aaaa1111", "pin": "current", "merge": "merged",
				"pinnedTreeHash": "tree2", "currentTreeHash": "tree2"},
		},
	})
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor("/bench/project-main/desktop/src")

	if ctx.Kind != ContextBench {
		t.Fatalf("kind = %q, want bench (a bench subdirectory is still the bench)", ctx.Kind)
	}
	b := ctx.Bench
	if b.BenchBranch != "ion/bench/main" || b.BaseSha != "aaaa1111" {
		t.Errorf("bench identity not carried: %+v", b)
	}
	// Order is contract: it is the order the assembly merges in, so it is the
	// order collisions are attributed in.
	if len(b.Members) != 2 || b.Members[0].BranchName != "wt/first" || b.Members[1].BranchName != "wt/second" {
		t.Fatalf("members must preserve recorded merge order: %+v", b.Members)
	}
	if b.Members[0].PinnedRange != "aaaa1111..1111" {
		t.Errorf("the exact pinned range must be stated, got %q", b.Members[0].PinnedRange)
	}
	if b.Members[0].Title != "first worktree" {
		t.Errorf("titles must be joined from the worktree registry, got %q", b.Members[0].Title)
	}

	prose := ctx.Format()
	for _, want := range []string{"/bench/project-main", "ion/bench/main", "aaaa1111..1111", "/wt/first", "WorkspaceAttribution", "destroyed"} {
		if !strings.Contains(prose, want) {
			t.Errorf("formatted bench context must mention %q:\n%s", want, prose)
		}
	}
	// Merge order must survive into the prose too, since that is what a model
	// reads.
	if strings.Index(prose, "wt/first") > strings.Index(prose, "wt/second") {
		t.Errorf("prose must list members in merge order:\n%s", prose)
	}
}

// Disabled members are reported SEPARATELY. Merging them into the member list
// would attribute assembled bytes to work the bench never received.
func TestPromptContextSeparatesDisabledMembers(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"members": []map[string]any{
			{"worktreePath": "/wt/on", "branchName": "wt/on", "enabled": true, "pinnedSha": "1", "pinnedBaseSha": "0"},
			{"worktreePath": "/wt/off", "branchName": "wt/off", "enabled": false, "pinnedSha": "2", "pinnedBaseSha": "0"},
		},
	})
	c := NewCheckerAt(dir)

	b := c.PromptContextFor("/bench/project-main").Bench

	if len(b.Members) != 1 || b.Members[0].BranchName != "wt/on" {
		t.Fatalf("only enabled members are contributors: %+v", b.Members)
	}
	if len(b.DisabledMembers) != 1 || b.DisabledMembers[0].BranchName != "wt/off" {
		t.Fatalf("disabled members must be reported separately: %+v", b.DisabledMembers)
	}
	prose := c.PromptContextFor("/bench/project-main").Format()
	if !strings.Contains(prose, "DISABLED") || !strings.Contains(prose, "not in this bench") {
		t.Errorf("the prose must state that disabled members own no bench content:\n%s", prose)
	}
}

// ─── Warnings ────────────────────────────────────────────────────────────────

// A FAILED assembly means the bench was wiped to an empty tree, so anything
// built or tested there is not the enrolled combination. Silence here would let
// an agent draw conclusions from nothing.
func TestPromptContextWarnsOnFailedAssembly(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"lastAssembly": "failed", "lastAssemblyError": "wt/beta conflicted in app.txt",
		"members": []map[string]any{
			{"worktreePath": "/wt/on", "branchName": "wt/on", "enabled": true, "pinnedSha": "1", "pinnedBaseSha": "0"},
		},
	})
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor("/bench/project-main")

	if !containsAny(ctx.Bench.Warnings, "wiped to an empty tree") {
		t.Fatalf("a failed assembly must warn that the bench holds no member content: %v", ctx.Bench.Warnings)
	}
	if !containsAny(ctx.Bench.Warnings, "wt/beta conflicted in app.txt") {
		t.Errorf("the recorded assembly error must be surfaced: %v", ctx.Bench.Warnings)
	}
}

// An ABSENT outcome is unknown — never read as success and never as failure.
func TestPromptContextWarnsOnUnknownAssemblyOutcome(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"members": []map[string]any{
			{"worktreePath": "/wt/on", "branchName": "wt/on", "enabled": true, "pinnedSha": "1", "pinnedBaseSha": "0"},
		},
	})
	c := NewCheckerAt(dir)

	warnings := c.PromptContextFor("/bench/project-main").Bench.Warnings

	if !containsAny(warnings, "unknown") {
		t.Fatalf("an absent assembly outcome must be reported as unknown: %v", warnings)
	}
}

// A STALE pin means the bench holds work the member has already moved past, so
// a diagnosis made in the bench may already be answered in the member.
func TestPromptContextWarnsOnStalePin(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"lastAssembly": "assembled",
		"members": []map[string]any{
			{"worktreePath": "/wt/stale", "branchName": "wt/stale", "enabled": true,
				"pinnedSha": "1", "pinnedBaseSha": "0",
				"pinnedTreeHash": "old", "currentTreeHash": "new"},
		},
	})
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor("/bench/project-main")

	if !ctx.Bench.Members[0].Stale {
		t.Fatal("differing tree hashes must report as stale")
	}
	if !containsAny(ctx.Bench.Warnings, "behind their worktrees") {
		t.Fatalf("a stale pin must warn: %v", ctx.Bench.Warnings)
	}
}

// ABSENT tree hashes are UNKNOWN freshness, not freshness. Reading an absent
// hash as current would assert a fact the record does not carry.
func TestPromptContextDistinguishesUnknownStalenessFromCurrent(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"lastAssembly": "assembled",
		"members": []map[string]any{
			{"worktreePath": "/wt/nohash", "branchName": "wt/nohash", "enabled": true,
				"pinnedSha": "1", "pinnedBaseSha": "0"},
		},
	})
	c := NewCheckerAt(dir)

	m := c.PromptContextFor("/bench/project-main").Bench.Members[0]

	if m.Stale {
		t.Error("an absent hash must not report as stale")
	}
	if m.StalenessKnown {
		t.Error("an absent hash must report freshness as UNKNOWN, not as known-current")
	}
	if !containsAny(c.PromptContextFor("/bench/project-main").Bench.Warnings, "freshness is unknown") {
		t.Error("unknown freshness must be warned about rather than silently read as current")
	}
}

func TestPromptContextWarnsOnConflictAndReplayedResolution(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"lastAssembly": "assembled",
		"members": []map[string]any{
			{"worktreePath": "/wt/c", "branchName": "wt/c", "enabled": true,
				"pinnedSha": "1", "pinnedBaseSha": "0", "merge": "conflicted",
				"conflictPaths": []string{"app.txt"}, "conflictsWith": []string{"wt/other"},
				"pinnedTreeHash": "t", "currentTreeHash": "t"},
			{"worktreePath": "/wt/r", "branchName": "wt/r", "enabled": true,
				"pinnedSha": "2", "pinnedBaseSha": "0", "merge": "merged",
				"mergeResolution": "replayed", "pinnedTreeHash": "t", "currentTreeHash": "t"},
		},
	})
	c := NewCheckerAt(dir)

	warnings := c.PromptContextFor("/bench/project-main").Bench.Warnings

	if !containsAny(warnings, "CONFLICTS") || !containsAny(warnings, "app.txt") || !containsAny(warnings, "wt/other") {
		t.Errorf("a conflicted member must be warned about with its paths and colliders: %v", warnings)
	}
	if !containsAny(warnings, "replayed") {
		t.Errorf("a replayed resolution is not the same fact as a clean merge and must be surfaced: %v", warnings)
	}
}

// An EMPTY contribution (equal base and tip) is distinct from having landed, and
// the record is the only place that fact survives.
func TestPromptContextWarnsOnEmptyContribution(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"lastAssembly": "assembled",
		"members": []map[string]any{
			{"worktreePath": "/wt/empty", "branchName": "wt/empty", "enabled": true,
				"pinnedSha": "same", "pinnedBaseSha": "same",
				"pinnedTreeHash": "t", "currentTreeHash": "t"},
		},
	})
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor("/bench/project-main")

	if !ctx.Bench.Members[0].EmptyContribution {
		t.Fatal("an equal base/tip pair is an empty contribution")
	}
	if !containsAny(ctx.Bench.Warnings, "contributes nothing") {
		t.Fatalf("an empty contribution must be stated: %v", ctx.Bench.Warnings)
	}
}

// A bench with no enabled members says so rather than rendering an empty list
// that reads like missing data.
func TestPromptContextStatesBenchWithNoEnabledMembers(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"lastAssembly": "assembled",
	})
	c := NewCheckerAt(dir)

	if !strings.Contains(c.PromptContextFor("/bench/project-main").Format(), "No enabled members") {
		t.Error("an empty bench must say so explicitly")
	}
}

// ─── The struct is the contract ──────────────────────────────────────────────

// Every fact the formatter renders must be reachable as a field, because a
// consumer that wants its own prose reads the struct. A round-trip through JSON
// pins that the struct is serializable — it crosses a hook payload boundary.
func TestPromptContextSerializesForConsumers(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"benchBranch": "ion/bench/main", "baseSha": "aaaa", "lastAssembly": "assembled",
		"members": []map[string]any{
			{"worktreePath": "/wt/a", "branchName": "wt/a", "enabled": true,
				"pinnedSha": "1", "pinnedBaseSha": "aaaa", "pin": "current", "merge": "merged",
				"pinnedTreeHash": "t", "currentTreeHash": "t"},
		},
	})
	c := NewCheckerAt(dir)

	raw, err := json.Marshal(c.PromptContextFor("/bench/project-main"))
	if err != nil {
		t.Fatalf("prompt context must serialize: %v", err)
	}
	var back PromptContext
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("prompt context must round-trip: %v", err)
	}
	if back.Kind != ContextBench || back.Bench == nil {
		t.Fatalf("round-trip lost the bench: %s", raw)
	}
	if len(back.Bench.Members) != 1 || back.Bench.Members[0].PinnedRange != "aaaa..1" {
		t.Fatalf("round-trip lost the pinned range: %s", raw)
	}
	// The formatter must be derivable from the round-tripped struct alone: if it
	// is not, some fact lives only in the checker and consumers cannot reach it.
	if back.Format() != c.PromptContextFor("/bench/project-main").Format() {
		t.Error("formatting the round-tripped struct must match; a fact exists outside the contract")
	}
}

// An unrecognized future pin/merge value passes through verbatim rather than
// collapsing into a wrong known value.
func TestPromptContextPassesThroughUnknownStateValues(t *testing.T) {
	dir := t.TempDir()
	writeBenchRecord(t, dir, map[string]any{
		"repoPath": repoPath, "sourceBranch": "main", "benchPath": "/bench/project-main",
		"lastAssembly": "some-future-outcome",
		"members": []map[string]any{
			{"worktreePath": "/wt/a", "branchName": "wt/a", "enabled": true,
				"pinnedSha": "1", "pinnedBaseSha": "0",
				"pin": "future-pin-state", "merge": "future-merge-state",
				"pinnedTreeHash": "t", "currentTreeHash": "t"},
		},
	})
	c := NewCheckerAt(dir)

	ctx := c.PromptContextFor("/bench/project-main")

	m := ctx.Bench.Members[0]
	if m.Pin != "future-pin-state" || m.Merge != "future-merge-state" {
		t.Fatalf("unknown state values must pass through verbatim: %+v", m)
	}
	if ctx.Bench.LastAssembly != "some-future-outcome" {
		t.Fatalf("an unknown assembly outcome must pass through: %q", ctx.Bench.LastAssembly)
	}
	// An unknown outcome is neither assembled nor failed, so neither of those
	// warnings may fire.
	if containsAny(ctx.Bench.Warnings, "wiped to an empty tree") {
		t.Error("an unrecognized outcome must not be read as a failure")
	}
}
