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
		"git -C " + minePath + " push origin HEAD",
	} {
		if r := c.Check("Bash", bashInput(cmd), minePath); r != nil {
			t.Fatalf("%q is work in the conversation's own worktree and must pass: %+v", cmd, r)
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

func TestWorkspaceBashMergeDriverDetection(t *testing.T) {
	driver := resolveBashDestinations("git merge --continue", "/cwd")
	if !driver.Segments[0].MergeDriverOnly || driver.Segments[0].MergeDriver != "continue" {
		t.Fatal("merge --continue must classify as continue driver")
	}
	if !driver.Segments[0].MergeDriverExact {
		t.Fatal("merge --continue must match exact grammar")
	}

	valid := []string{
		"git merge --abort",
		"/usr/bin/git merge --continue",
		"git -C /cwd merge --continue",
		"git --no-pager -c user.name=test merge --abort",
		"git --git-dir=/tmp/repo.git merge --continue",
	}
	for _, command := range valid {
		got := resolveBashDestinations(command, "/cwd")
		if len(got.Segments) == 0 || got.Segments[0].MergeDriver == "" || !got.Segments[0].MergeDriverExact {
			t.Fatalf("%q: valid exact driver not recognized: %+v", command, got)
		}
	}

	unsafe := []string{
		"git merge --continue && echo hidden",
		"git merge --continue &",
		"git merge --continue >out",
		"git merge --continue <in",
		"git merge --continue | cat",
		"git merge --continue; true",
		"(git merge --continue)",
		"{ git merge --continue; }",
		"env git merge --continue",
		"sudo git merge --continue",
		"git merge --continue extra",
		"git merge --continue --quiet",
		"git merge --continue $(echo hidden)",
		"git merge --continue `echo hidden`",
		"sh -c 'git merge --continue'",
		"git merge \"--continue\"",
		"git merge --continue\n",
	}
	for _, command := range unsafe {
		got := resolveBashDestinations(command, "/cwd")
		found := false
		exact := false
		for _, segment := range got.Segments {
			found = found || segment.MergeDriver != ""
			exact = exact || segment.MergeDriverExact
		}
		if !found {
			t.Fatalf("%q: unsafe driver attempt must remain detectable", command)
		}
		if exact {
			t.Fatalf("%q: unsafe driver matched exact grammar", command)
		}
	}

	fresh := resolveBashDestinations("git merge feature", "/cwd")
	if fresh.Segments[0].MergeDriverOnly {
		t.Fatal("a fresh merge must not classify as driver-only")
	}
}

func TestWorkspaceClassifyMergeDriver(t *testing.T) {
	f := newBenchFixture(t)

	got := f.checker.ClassifyMergeDriver("Bash", bashInput("git merge --continue"), f.benchPath)
	if got.Driver != MergeDriverContinue || got.BenchPath != f.benchPath {
		t.Fatalf("continue classification = %+v", got)
	}
	if got := f.checker.ClassifyMergeDriver("Read", map[string]interface{}{}, f.benchPath); got.Driver != "" {
		t.Fatalf("non-Bash tool classified as merge driver: %+v", got)
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
