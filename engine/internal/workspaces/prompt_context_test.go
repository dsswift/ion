package workspaces

// Workspace prompt context: the structured facts and the generic formatter.
//
// The property under test throughout is that the STRUCT is the contract. A
// consumer that wants different prose reads the struct, so every fact the
// formatter renders must be present as a field — and no fact may exist only in
// the prose, where a consumer cannot reach it.

import (
	"encoding/json"
	"strings"
	"testing"
)

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
	// With a sibling present, the prose must point at the cross-worktree query
	// tools -- this is the discoverability fix: a model that does not know
	// these tools exist defaults to the wrong assumption that it cannot see a
	// sibling's work at all.
	for _, want := range []string{"WorktreeList", "WorktreeCommits", "WorktreeDiff"} {
		if !strings.Contains(prose, want) {
			t.Errorf("formatted context with siblings must point at %q:\n%s", want, prose)
		}
	}
}

// The branch-attachment invariant, stated as an end state rather than a verb
// blocklist.
//
// This assertion set moved here from internal/gitcontext, which used to inject a
// second "# Worktree Safety" section saying the same thing in different words on
// every dispatch. It pins BOTH directions, because both have been wrong in
// shipped code: the invariant must be present, and the sanctioned history verbs
// must NOT be forbidden — an earlier revision told the model not to rebase,
// reset, or stash at all, which contradicted the operator's own /align amend
// sequence, /squash rebuild, and /create-pr push.
func TestPromptContextStatesTheAttachmentInvariantWithoutForbiddingWorkflowVerbs(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath, BranchName: "wt/mine", SourceBranch: "main"},
	})
	prose := NewCheckerAt(dir).PromptContextFor(minePath).Format()

	for _, want := range []string{
		"End every turn with HEAD attached to wt/mine",
		"`--continue`",
		"`--abort`",
		"reported as missing",
	} {
		if !strings.Contains(prose, want) {
			t.Errorf("worktree prose must state the attachment invariant (%q):\n%s", want, prose)
		}
	}

	// The verbs the operator's workflows depend on are named as ALLOWED.
	for _, allowed := range []string{"amending", "rebasing", "resetting", "stashing", "pushing"} {
		if !strings.Contains(prose, allowed) {
			t.Errorf("worktree prose must name %q as permitted:\n%s", allowed, prose)
		}
	}
	for _, forbidden := range []string{
		"Do not run git rebase", "Do not run git reset", "Do not run git stash",
		"Do not run git push", "Do not run git commit",
	} {
		if strings.Contains(prose, forbidden) {
			t.Errorf("worktree prose must not forbid a sanctioned workflow verb (%q):\n%s", forbidden, prose)
		}
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

// ─── The struct is the contract ──────────────────────────────────────────────

// Every fact the formatter renders must be reachable as a field, because a
// consumer that wants its own prose reads the struct. A round-trip through JSON
// pins that the struct is serializable — it crosses a hook payload boundary.
func TestPromptContextSerializesForConsumers(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath, BranchName: "wt/mine",
			SourceBranch: "main", Title: "fix the streaming retry loop"},
		{WorktreePath: sibling, RepoPath: repoPath, BranchName: "wt/other"},
	})
	c := NewCheckerAt(dir)

	raw, err := json.Marshal(c.PromptContextFor(minePath))
	if err != nil {
		t.Fatalf("prompt context must serialize: %v", err)
	}
	var back PromptContext
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("prompt context must round-trip: %v", err)
	}
	if back.Kind != ContextWorktree || back.Worktree == nil {
		t.Fatalf("round-trip lost the worktree: %s", raw)
	}
	if len(back.Worktree.Siblings) != 1 || back.Worktree.Siblings[0].WorktreePath != sibling {
		t.Fatalf("round-trip lost the siblings: %s", raw)
	}
	// The formatter must be derivable from the round-tripped struct alone: if it
	// is not, some fact lives only in the checker and consumers cannot reach it.
	if back.Format() != c.PromptContextFor(minePath).Format() {
		t.Error("formatting the round-tripped struct must match; a fact exists outside the contract")
	}
}

func TestPromptContextBenchFieldSerializes(t *testing.T) {
	ctx := PromptContext{
		Kind: ContextKind("bench"),
		Cwd:  "/bench/project",
		Bench: map[string]any{
			"benchPath": "/bench/project",
			"members":   []any{"a", "b"},
		},
		Client: map[string]any{"extra": "data"},
	}

	raw, err := json.Marshal(ctx)
	if err != nil {
		t.Fatalf("bench prompt context must serialize: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("must decode to map: %v", err)
	}
	if _, ok := wire["bench"]; !ok {
		t.Error("bench field must be present in serialized JSON")
	}
	if _, ok := wire["client"]; !ok {
		t.Error("client field must be present in serialized JSON")
	}
	if _, ok := wire["worktree"]; ok {
		t.Error("worktree must be omitted when nil (omitempty)")
	}

	var back PromptContext
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("bench context must round-trip: %v", err)
	}
	if back.Bench == nil {
		t.Fatal("bench field lost on round-trip")
	}
	if back.Client == nil {
		t.Fatal("client field lost on round-trip")
	}
}

func TestPromptContextOmitsEmptyBenchAndClient(t *testing.T) {
	ctx := PromptContext{
		Kind: ContextKind("worktree"),
		Cwd:  "/wt/project",
	}

	raw, err := json.Marshal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if _, ok := wire["bench"]; ok {
		t.Error("bench must be omitted when nil (omitempty)")
	}
	if _, ok := wire["client"]; ok {
		t.Error("client must be omitted when nil (omitempty)")
	}
}
