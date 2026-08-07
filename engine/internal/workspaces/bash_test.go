package workspaces

import (
	"path/filepath"
	"testing"
)

// ─── Bash destination resolution (worktree escape via cd / git -C) ──────────

func worktreeChecker(t *testing.T) *Checker {
	t.Helper()
	dir := t.TempDir()
	standardRegistry(t, dir)
	return NewCheckerAt(dir)
}

func TestWorkspaceBashRefusesCdIntoBaseRepoAndCommit(t *testing.T) {
	c := worktreeChecker(t)

	// The exact escape shape that once landed two commits on the wrong branch.
	r := c.Check("Bash", bashInput("cd "+repoPath+" && git commit -m x"), minePath)
	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("cd-into-base-repo must be refused, got %+v", r)
	}
}

func TestWorkspaceBashRefusesGitCIntoBaseRepo(t *testing.T) {
	c := worktreeChecker(t)

	r := c.Check("Bash", bashInput("git -C "+repoPath+" commit -m x"), minePath)
	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("git -C into the base repo must be refused, got %+v", r)
	}
}

func TestWorkspaceBashRefusesPushdIntoSibling(t *testing.T) {
	c := worktreeChecker(t)

	r := c.Check("Bash", bashInput("pushd "+sibling+"; make build"), minePath)
	if r == nil || r.Kind != RefusalSiblingWorktree {
		t.Fatalf("pushd into a sibling must be refused, got %+v", r)
	}
}

func TestWorkspaceBashCdPersistsAcrossSegments(t *testing.T) {
	c := worktreeChecker(t)

	// The cd's effect carries into later segments of the same command string.
	r := c.Check("Bash", bashInput("cd "+repoPath+"; echo ok; git status"), minePath)
	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("cd effect must persist across segment boundaries, got %+v", r)
	}
}

func TestWorkspaceBashPassesWorkInsideOwnWorktree(t *testing.T) {
	c := worktreeChecker(t)

	for _, cmd := range []string{
		"git add -A && git commit -m 'own worktree work'",
		"cd " + filepath.Join(minePath, "desktop") + " && npm test",
		"make build",
	} {
		if r := c.Check("Bash", bashInput(cmd), minePath); r != nil {
			t.Fatalf("%q is work in the conversation's own worktree and must pass: %+v", cmd, r)
		}
	}
}

func TestWorkspaceBashRefusesWorktreeIdentityChange(t *testing.T) {
	c := worktreeChecker(t)

	for _, command := range []string{
		"git checkout --detach HEAD",
		"git checkout -b other-branch",
		"git checkout -B other-branch HEAD",
		"git switch main",
		"git switch --detach HEAD",
		"git worktree remove /tmp/other",
		"git worktree prune",
		"git -C " + minePath + " switch main",
		"cd " + minePath + " && git switch main",
	} {
		r := c.Check("Bash", bashInput(command), minePath)
		if r == nil || r.Kind != RefusalWorktreeHistory {
			t.Fatalf("%q changes worktree identity and must be refused, got %+v", command, r)
		}
	}
}

// The same guard against a REAL registered worktree, whose path is symlinked.
//
// The synthetic-path test above cannot catch the defect this one exists for. Its
// `minePath` does not exist on disk, so canonicalization falls back to the
// lexical form and a bare prefix comparison happens to work. A real worktree on
// macOS lives under a temp dir that resolves /var -> /private/var, so the
// recorded root and the resolved segment directory compare UNEQUAL lexically —
// and the guard silently stopped firing for every real worktree while this
// suite stayed green. Both sides must be canonicalized (Checker.within).
func TestWorkspaceBashRefusesIdentityChangeInRealWorktree(t *testing.T) {
	checker, worktree := attachmentFixture(t)

	for _, command := range []string{
		"git checkout --detach HEAD",
		"git checkout -b other-branch",
		"git switch main",
		"git worktree remove /tmp/other",
		"git worktree prune",
	} {
		r := checker.Check("Bash", bashInput(command), worktree)
		if r == nil || r.Kind != RefusalWorktreeHistory {
			t.Fatalf("%q must be refused in a real worktree (canonical-path comparison), got %+v", command, r)
		}
	}

	// And the sanctioned verbs still pass there, so the fix cannot have been a
	// blanket widening of the refusal.
	for _, command := range []string{
		"git rebase --continue",
		"git reset --soft main",
		"git commit --amend",
		"git push -u origin HEAD",
		"git branch -f backup HEAD",
	} {
		if r := checker.Check("Bash", bashInput(command), worktree); r != nil {
			t.Fatalf("%q is sanctioned workflow and must pass in a real worktree: %s", command, r.Reason)
		}
	}
}

// The workflows the first revision of this guard broke. Each sequence is copied
// from the operator's own commands: /align's amend mechanism (B-Step 6),
// /squash's soft-reset rebuild (Step 7), and /create-pr's push (Step 4). A
// regression here means the guard has started refusing sanctioned work again.
func TestWorkspaceBashPassesOperatorGitWorkflows(t *testing.T) {
	c := worktreeChecker(t)

	for name, command := range map[string]string{
		"align stash":            `git stash push -u -m "align-fixes" -- engine/x.go`,
		"align rebase -i":        `GIT_SEQUENCE_EDITOR="sed -i '' '3s/^pick/edit/'" git rebase -i abc123^`,
		"align amend":            "git stash pop && git add engine/x.go && git commit --amend",
		"align rebase continue":  "git rebase --continue",
		"align rebase abort":     "git rebase --abort",
		"align pr worktree add":  "git worktree add ../ion-align-pr-287 feat/branch",
		"squash backup branch":   "git branch backup--wt/feature HEAD",
		"squash backup force":    "git branch -f backup--wt/feature HEAD",
		"squash soft reset":      "git reset --soft josh",
		"squash unstage":         "git reset",
		"squash verify":          "git diff backup--wt/feature",
		"create-pr push":         "git push -u origin wt/feature",
		"cherry-pick":            "git cherry-pick deadbeef",
		"revert":                 "git revert HEAD",
		"restore staged":         "git restore --staged engine/x.go",
		"clean force":            "git clean -fd",
		"checkout file restore":  "git checkout engine/x.go",
		"checkout conflict side": "git checkout --theirs engine/x.go",
		"switch continue":        "git switch --continue",
	} {
		if r := c.Check("Bash", bashInput(command), minePath); r != nil {
			t.Fatalf("%s (%q) is sanctioned workflow and must pass, got %+v", name, command, r)
		}
	}
}

func TestWorkspaceBashPassesSafeHistoryInsideOwnWorktree(t *testing.T) {
	c := worktreeChecker(t)
	for _, command := range []string{
		"git status --short",
		"git diff --cached",
		"git add -A && git commit -m work",
		"git log --oneline -5",
		"git branch --show-current",
		"git branch -d stale-branch",
		"git clean -nfd",
		"git worktree list",
	} {
		if r := c.Check("Bash", bashInput(command), minePath); r != nil {
			t.Fatalf("%q must remain allowed, got %+v", command, r)
		}
	}
}

func TestWorkspaceBashPassesUnrelatedDestinations(t *testing.T) {
	c := worktreeChecker(t)

	// Not a cwd jail: /tmp and unrelated directories pass.
	for _, cmd := range []string{
		"cd /tmp && ./run-probe.sh",
		"git -C /somewhere/else log --oneline",
	} {
		if r := c.Check("Bash", bashInput(cmd), minePath); r != nil {
			t.Fatalf("%q must pass, got %+v", cmd, r)
		}
	}
}

// A dynamic destination cannot be resolved: the command PASSES (a refusal
// requires a literal path — false refusals in the operator's own worktree are
// worse than the residual gap) and the unresolved construct is surfaced for
// WARN logging.
func TestWorkspaceBashDynamicDestinationsPass(t *testing.T) {
	c := worktreeChecker(t)

	for _, cmd := range []string{
		`cd "$TARGET" && git commit -m x`,
		"cd $(git rev-parse --show-toplevel) && git commit -m x",
		"cd ~/somewhere && git commit -m x",
	} {
		if r := c.Check("Bash", bashInput(cmd), minePath); r != nil {
			t.Fatalf("dynamic destination %q must pass, got %+v", cmd, r)
		}
	}
}

func TestWorkspaceBashDynamicDestinationSurfacesHint(t *testing.T) {
	dest := resolveBashDestinations(`cd "$TARGET" && git commit -m x`, minePath)
	if dest.UnresolvedHint == "" {
		t.Fatal("dynamic cd must surface an unresolved hint for WARN logging")
	}
}

// Quoted operators must not split segments: a commit message containing "&&"
// is message text, not a command boundary.
func TestWorkspaceBashQuotedOperatorsDoNotSplit(t *testing.T) {
	dest := resolveBashDestinations(`git commit -m "fix a && b"`, minePath)
	if len(dest.Segments) != 1 {
		t.Fatalf("quoted && split the command: %+v", dest.Segments)
	}
	if len(dest.Segments[0].GitSubcommands) != 1 || dest.Segments[0].GitSubcommands[0] != "commit" {
		t.Fatalf("subcommands = %v, want [commit]", dest.Segments[0].GitSubcommands)
	}
}

func TestWorkspaceBashSubcommandExtraction(t *testing.T) {
	cases := []struct {
		command string
		want    []string
	}{
		{"git commit -m x", []string{"commit"}},
		{"git -C /repo commit -m x", []string{"commit"}},             // skips the -C pair
		{"git -c user.name=X commit", []string{"commit"}},            // skips the -c pair
		{"/usr/bin/git status", []string{"status"}},                  // absolute git path
		{"git add -A && git commit -m x", []string{"add", "commit"}}, // both, in order
		{"npm run build", nil},                                       // no git call
		{"gitleaks detect", nil},                                     // not git
	}
	for _, tc := range cases {
		var got []string
		for _, seg := range resolveBashDestinations(tc.command, "/cwd").Segments {
			got = append(got, seg.GitSubcommands...)
		}
		if len(got) != len(tc.want) {
			t.Fatalf("%q: subcommands = %v, want %v", tc.command, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("%q: subcommands = %v, want %v", tc.command, got, tc.want)
			}
		}
	}
}

// Merge-driver flags are ordinary git arguments to the engine now (client
// tool gates own any merge-driver policy); the extraction must still see
// `git merge --continue` as a `merge` invocation with its arguments intact so
// downstream policy consumers get the full operation.
func TestWorkspaceBashMergeArgumentsSurviveExtraction(t *testing.T) {
	got := resolveBashDestinations("git merge --continue", "/cwd")
	if len(got.Segments) != 1 || len(got.Segments[0].GitOperations) != 1 {
		t.Fatalf("merge --continue must extract one git operation: %+v", got.Segments)
	}
	op := got.Segments[0].GitOperations[0]
	if op.Subcommand != "merge" || len(op.Arguments) != 1 || op.Arguments[0] != "--continue" {
		t.Fatalf("merge --continue must retain subcommand and arguments, got %+v", op)
	}
}

func TestWorkspaceBashRelativeCdResolvesAgainstCwd(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: "/repo/wt-a", RepoPath: "/repo"},
	})
	c := NewCheckerAt(dir)

	// `cd ..` from the worktree resolves into the base repo.
	r := c.Check("Bash", bashInput("cd .. && git commit -m x"), "/repo/wt-a")
	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("relative cd escape must be refused, got %+v", r)
	}
}
