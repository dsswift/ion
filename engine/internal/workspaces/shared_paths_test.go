package workspaces

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Shared-path allowance: a worktree conversation may write into a base-repo
// path the project DECLARED in .ion/worktree.json AND that git IGNORES. Both
// conditions are required; see shared_paths.go for why.
//
// These tests use real directories (not the /repo, /wt string fixtures the
// other containment tests use) because the allowance calls git and stats the
// manifest, so the paths have to exist.

// sharedFixture builds a real base repo + worktree pair and returns the ion
// dir, the repo path, and the worktree path.
func sharedFixture(t *testing.T, sharedPaths []string, ignoreLines string) (ionDir, repo, worktree string) {
	t.Helper()

	root := t.TempDir()
	ionDir = filepath.Join(root, "ion")
	repo = filepath.Join(root, "repo")
	worktree = filepath.Join(root, "wt")
	for _, d := range []string{ionDir, repo, worktree} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	writeWorktreeRegistry(t, ionDir, []WorktreeEntry{
		{WorktreePath: worktree, RepoPath: repo},
	})

	if sharedPaths != nil {
		manifest := map[string]any{
			"version":  1,
			"worktree": map[string]any{"sharedPaths": sharedPaths},
		}
		raw, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(repo, ".ion"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(repo, ".ion", "worktree.json"), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if ignoreLines != "" {
		if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte(ignoreLines), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// A real git repo, because the allowance is proven by `git check-ignore`
	// rather than by parsing .gitignore ourselves.
	if _, err := runGit(repo, "init", "--quiet"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}

	return ionDir, repo, worktree
}

// ─── The allowance ──────────────────────────────────────────────────────────

// A declared + gitignored path is writable. Without the fix this refuses,
// which is the blocker this feature exists to remove.
func TestSharedPathAllowsDeclaredIgnoredWrite(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, []string{"docs/retros"}, "docs/retros/\n")
	c := NewCheckerAt(ionDir)

	target := filepath.Join(repo, "docs", "retros", "2026-09-07-run.md")
	if r := c.Check("Write", writeInput(target), worktree); r != nil {
		t.Fatalf("expected the declared, gitignored path to be writable, got refusal: %s", r.Reason)
	}
}

// The allowance is scoped to the declared subtree, not the whole repo.
func TestSharedPathStillRefusesTrackedSibling(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, []string{"docs/retros"}, "docs/retros/\n")
	c := NewCheckerAt(ionDir)

	r := c.Check("Write", writeInput(filepath.Join(repo, "engine", "main.go")), worktree)
	if r == nil {
		t.Fatal("expected a refusal for a tracked base-repo path outside the shared declaration")
	}
	if r.Kind != RefusalBaseRepo {
		t.Fatalf("expected RefusalBaseRepo, got %q", r.Kind)
	}
}

// ─── Both conditions are required ───────────────────────────────────────────

// Declared but NOT gitignored: refused. This is the condition that stops a
// project from re-opening the interleaving hole by declaring a tracked dir.
func TestSharedPathRefusesDeclaredButNotIgnored(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, []string{"docs/reports"}, "")
	c := NewCheckerAt(ionDir)

	r := c.Check("Write", writeInput(filepath.Join(repo, "docs", "reports", "x.md")), worktree)
	if r == nil {
		t.Fatal("expected a refusal: the path is declared but git does not ignore it")
	}
	if r.Kind != RefusalBaseRepo {
		t.Fatalf("expected RefusalBaseRepo, got %q", r.Kind)
	}
}

// Gitignored but NOT declared: refused. Ignoring a path is not an opt-in, or
// every node_modules and .env in the repo would become writable.
func TestSharedPathRefusesIgnoredButNotDeclared(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, []string{"docs/retros"}, "docs/retros/\nnode_modules/\n")
	c := NewCheckerAt(ionDir)

	r := c.Check("Write", writeInput(filepath.Join(repo, "node_modules", "pkg", "index.js")), worktree)
	if r == nil {
		t.Fatal("expected a refusal: node_modules is gitignored but was never declared shared")
	}
}

// No manifest at all: the pre-existing refusal stands unchanged.
func TestSharedPathNoManifestRefuses(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, nil, "docs/retros/\n")
	c := NewCheckerAt(ionDir)

	r := c.Check("Write", writeInput(filepath.Join(repo, "docs", "retros", "x.md")), worktree)
	if r == nil {
		t.Fatal("expected a refusal when no manifest declares any shared path")
	}
}

// A malformed manifest fails CLOSED. Every other read in this package fails
// open, so this direction is the one worth pinning: a corrupt file must not
// silently disable containment.
func TestSharedPathMalformedManifestFailsClosed(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, []string{"docs/retros"}, "docs/retros/\n")
	if err := os.WriteFile(filepath.Join(repo, ".ion", "worktree.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := NewCheckerAt(ionDir)

	r := c.Check("Write", writeInput(filepath.Join(repo, "docs", "retros", "x.md")), worktree)
	if r == nil {
		t.Fatal("expected a refusal: a malformed manifest must not grant any allowance")
	}
}

// ─── Declaration cannot reach outside the repo ──────────────────────────────

func TestSharedPathRejectsTraversalEscape(t *testing.T) {
	ionDir, repo, _ := sharedFixture(t, []string{"../outside"}, "")
	c := NewCheckerAt(ionDir)

	outside := filepath.Join(filepath.Dir(repo), "outside", "x.md")
	if err := os.MkdirAll(filepath.Dir(outside), 0o755); err != nil {
		t.Fatal(err)
	}

	// The escape is rejected as a DECLARATION. The write itself lands outside
	// the repo and outside the worktree, which containment does not police at
	// all, so the assertion that matters is that the root was never accepted.
	if roots := c.sharedRoots(repo); len(roots) != 0 {
		t.Fatalf("expected a traversal declaration to be rejected, got roots %v", roots)
	}
}

func TestSharedPathRejectsAbsoluteDeclaration(t *testing.T) {
	ionDir, repo, _ := sharedFixture(t, []string{"/etc"}, "")
	c := NewCheckerAt(ionDir)

	if roots := c.sharedRoots(repo); len(roots) != 0 {
		t.Fatalf("expected an absolute declaration to be rejected, got roots %v", roots)
	}
}

func TestSharedPathRejectsRepoRoot(t *testing.T) {
	// "." resolves to the repo itself. Sharing the root would be a blanket
	// exemption, which is the opposite of a narrow declared allowance.
	ionDir, repo, _ := sharedFixture(t, []string{"."}, "")
	c := NewCheckerAt(ionDir)

	if roots := c.sharedRoots(repo); len(roots) != 0 {
		t.Fatalf("expected the repo root to be rejected as a shared path, got roots %v", roots)
	}
}

// ─── Bash ───────────────────────────────────────────────────────────────────

// Rendering a report is the motivating case: cd into the shared dir and run a
// non-git command there.
func TestSharedPathAllowsBashInSharedDir(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, []string{"docs/retros"}, "docs/retros/\n")
	c := NewCheckerAt(ionDir)

	shared := filepath.Join(repo, "docs", "retros")
	cmd := "cd " + shared + " && ion-render run.md"
	if r := c.Check("Bash", bashInput(cmd), worktree); r != nil {
		t.Fatalf("expected a non-git command in the shared dir to pass, got: %s", r.Reason)
	}
}

// The allowance exempts a path because git cannot see it. A git invocation is
// the one operation that would make it seen, so it stays refused even in a
// shared directory.
func TestSharedPathRefusesGitInSharedDir(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, []string{"docs/retros"}, "docs/retros/\n")
	c := NewCheckerAt(ionDir)

	shared := filepath.Join(repo, "docs", "retros")
	cmd := "cd " + shared + " && git add -A && git commit -m x"
	r := c.Check("Bash", bashInput(cmd), worktree)
	if r == nil {
		// Diagnostic dump: this refusal has been unexpectedly nil on a real
		// Windows CI runner (never reproduced on darwin or on an ARM64
		// Windows VM), so a plain "expected refused" leaves no way to tell
		// segment resolution apart from containment classification without a
		// fresh CI round-trip. Dump both.
		dest := resolveBashDestinations(cmd, worktree)
		var segs []string
		for _, s := range dest.Segments {
			segs = append(segs, fmt.Sprintf("{Dir:%q GitOps:%v}", s.Dir, s.GitSubcommands))
		}
		containment := c.Resolve(worktree)
		wc := containment.Worktree
		var wcDump string
		if wc == nil {
			wcDump = "<nil>"
		} else {
			wcDump = fmt.Sprintf("{WorktreePath:%q RepoPath:%q}", wc.WorktreePath, wc.RepoPath)
		}
		t.Fatalf("expected git in a shared base-repo dir to be refused\n  shared=%q\n  worktree=%q\n  repo=%q\n  segments=%v\n  containment.Worktree=%s\n  canonical(shared)=%q\n  canonical(repo)=%q\n  canonical(worktree)=%q",
			shared, worktree, repo, segs, wcDump, canonicalizePath(shared), canonicalizePath(repo), canonicalizePath(worktree))
	}
	if r.Kind != RefusalBaseRepo {
		t.Fatalf("expected RefusalBaseRepo, got %q", r.Kind)
	}
}

// ─── The manifest authority is the base repo, never the worktree ────────────

// A worktree carries its own committed copy of .ion/worktree.json. If the
// checker read THAT copy, a conversation could declare the whole repo shared
// from inside its sandbox and write anywhere — the guard would become
// advisory. The base repo's copy is the only authority.
func TestSharedPathIgnoresWorktreeLocalManifest(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, nil, "docs/retros/\n")

	// The worktree declares a shared path; the base repo declares nothing.
	manifest := map[string]any{
		"version":  1,
		"worktree": map[string]any{"sharedPaths": []string{"docs/retros", "engine"}},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(worktree, ".ion"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, ".ion", "worktree.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	c := NewCheckerAt(ionDir)

	r := c.Check("Write", writeInput(filepath.Join(repo, "docs", "retros", "x.md")), worktree)
	if r == nil {
		t.Fatal("a worktree-local manifest must not grant itself base-repo write access")
	}
}

// ─── Sibling worktrees are never shared ─────────────────────────────────────

// A sibling's gitignored path is that conversation's private build state, not
// a shared artifact directory.
func TestSharedPathNeverAppliesToSibling(t *testing.T) {
	root := t.TempDir()
	ionDir := filepath.Join(root, "ion")
	repo := filepath.Join(root, "repo")
	mine := filepath.Join(root, "wt-a")
	other := filepath.Join(root, "wt-b")
	for _, d := range []string{ionDir, repo, mine, other} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeWorktreeRegistry(t, ionDir, []WorktreeEntry{
		{WorktreePath: mine, RepoPath: repo},
		{WorktreePath: other, RepoPath: repo},
	})
	if err := os.MkdirAll(filepath.Join(repo, ".ion"), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"version":1,"worktree":{"sharedPaths":["docs/retros"]}}`
	if err := os.WriteFile(filepath.Join(repo, ".ion", "worktree.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("docs/retros/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := runGit(repo, "init", "--quiet"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}

	c := NewCheckerAt(ionDir)

	r := c.Check("Write", writeInput(filepath.Join(other, "docs", "retros", "x.md")), mine)
	if r == nil {
		t.Fatal("expected a sibling-worktree write to stay refused regardless of shared declarations")
	}
	if r.Kind != RefusalSiblingWorktree {
		t.Fatalf("expected RefusalSiblingWorktree, got %q", r.Kind)
	}
}

// ─── Trailing-slash retry ───────────────────────────────────────────────────

// A directory-only .gitignore pattern only matches a bare path that already
// exists as a directory. The shared dir usually does NOT exist on first use,
// which is exactly the case the allowance serves, so the check re-asks with a
// trailing slash.
func TestSharedPathIgnoreCheckHandlesMissingDirectory(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t, []string{"docs/retros"}, "docs/retros/\n")
	c := NewCheckerAt(ionDir)

	if _, err := os.Stat(filepath.Join(repo, "docs", "retros")); !os.IsNotExist(err) {
		t.Fatal("fixture precondition: the shared directory must not exist yet")
	}

	target := filepath.Join(repo, "docs", "retros", "first.md")
	if r := c.Check("Write", writeInput(target), worktree); r != nil {
		t.Fatalf("expected the not-yet-created shared dir to be writable, got: %s", r.Reason)
	}
}

// ─── Unaffected conversations ───────────────────────────────────────────────

// A conversation whose cwd is not a registered worktree is not gated at all,
// so the manifest is irrelevant to it.
func TestSharedPathIrrelevantOutsideWorktree(t *testing.T) {
	ionDir, repo, _ := sharedFixture(t, []string{"docs/retros"}, "docs/retros/\n")
	c := NewCheckerAt(ionDir)

	if r := c.Check("Write", writeInput(filepath.Join(repo, "engine", "main.go")), repo); r != nil {
		t.Fatalf("a non-worktree conversation must not be gated, got: %s", r.Reason)
	}
}

// ─── Declaration hygiene ────────────────────────────────────────────────────

// Several declarations resolve independently: one bad entry does not discard
// the good ones.
func TestSharedPathPartialDeclarationsResolveIndependently(t *testing.T) {
	ionDir, repo, worktree := sharedFixture(t,
		[]string{"docs/retros", "engine", "  ", "docs/reports"},
		"docs/retros/\ndocs/reports/\n")
	c := NewCheckerAt(ionDir)

	roots := c.sharedRoots(repo)
	if len(roots) != 2 {
		t.Fatalf("expected exactly the two ignored declarations to resolve, got %v", roots)
	}
	for _, want := range []string{"retros", "reports"} {
		found := false
		for _, r := range roots {
			if strings.HasSuffix(r, want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("expected a resolved root ending in %q, got %v", want, roots)
		}
	}

	if r := c.Check("Write", writeInput(filepath.Join(repo, "engine", "x.go")), worktree); r == nil {
		t.Fatal("the tracked 'engine' declaration must not have been accepted")
	}
}
