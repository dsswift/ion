package workspaces

// Path handling: canonicalization and symlink resolution.
//
// Every rule in this package is a comparison between a path and a root, so a
// path that has two spellings has two verdicts. These tests pin the failure
// direction that matters: a symlinked route into a protected root must still
// be recognized (or the guard is bypassable by `ln -s`), while a symlink to a
// harmless directory must not invent containment.

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ─── Symlink resolution: the guard must not be bypassable by `ln -s` ─────────

// A symlink into a worktree's BASE REPO is still the base repo.
func TestContainmentResolvesSymlinkIntoBaseRepo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	root := t.TempDir()
	ionDir := filepath.Join(root, "ion")
	repo := filepath.Join(root, "repo")
	worktree := filepath.Join(root, "wt")
	for _, d := range []string{ionDir, repo, worktree} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeWorktreeRegistry(t, ionDir, []WorktreeEntry{{WorktreePath: worktree, RepoPath: repo}})
	c := NewCheckerAt(ionDir)

	link := filepath.Join(root, "repo-link")
	if err := os.Symlink(repo, link); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}

	r := c.Check("Write", writeInput(filepath.Join(link, "main.go")), worktree)

	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("a symlinked route into the base repo must be refused, got %+v", r)
	}
}

// Canonicalization must not INVENT containment. A symlink pointing somewhere
// harmless stays harmless: over-refusal in a directory the operator is working
// in is the failure this package treats as worse than a missing guard.
func TestContainmentDoesNotRefuseUnrelatedSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	root := t.TempDir()
	ionDir := filepath.Join(root, "ion")
	repo := filepath.Join(root, "repo")
	worktree := filepath.Join(root, "wt")
	for _, d := range []string{ionDir, repo, worktree} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeWorktreeRegistry(t, ionDir, []WorktreeEntry{{WorktreePath: worktree, RepoPath: repo}})
	c := NewCheckerAt(ionDir)

	elsewhere := t.TempDir()
	link := filepath.Join(t.TempDir(), "safe-link")
	if err := os.Symlink(elsewhere, link); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}

	if r := c.Check("Write", writeInput(filepath.Join(link, "x.txt")), worktree); r != nil {
		t.Fatalf("a symlink to an unrelated directory must pass: %+v", r)
	}
}

// ─── canonicalizePath unit behaviour ─────────────────────────────────────────

// A path whose LEAF does not exist yet must canonicalize the same way as one
// that does. Otherwise a new-file write and an existing-file write in the same
// directory get two different spellings and compare differently against the
// same root — which is how a guard passes exactly the writes that create files.
func TestCanonicalizeAgreesForExistingAndMissingLeaf(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(real, "present.txt")
	if err := os.WriteFile(existing, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}

	viaLinkExisting := canonicalizePath(filepath.Join(link, "present.txt"))
	viaLinkMissing := canonicalizePath(filepath.Join(link, "not-yet.txt"))

	if filepath.Dir(viaLinkExisting) != filepath.Dir(viaLinkMissing) {
		t.Fatalf("existing and missing leaves canonicalized to different directories: %q vs %q", viaLinkExisting, viaLinkMissing)
	}
	if filepath.Dir(viaLinkExisting) != canonicalizePath(real) {
		t.Fatalf("the symlink was not resolved: %q want dir %q", viaLinkExisting, canonicalizePath(real))
	}
}

// A traversal is resolved lexically even when nothing on the path exists.
func TestCanonicalizeResolvesTraversal(t *testing.T) {
	got := canonicalizePath("/a/b/../c/./d")
	if got != filepath.Clean("/a/c/d") {
		t.Fatalf("canonicalizePath(%q) = %q", "/a/b/../c/./d", got)
	}
}

// An unresolvable path falls back to its lexical form rather than to empty: an
// empty path would make every containment comparison silently false, disabling
// the guard exactly when the filesystem is uncooperative.
func TestCanonicalizeFallsBackToLexicalForm(t *testing.T) {
	got := canonicalizePath("/definitely/does/not/exist/anywhere/x.txt")
	if got != filepath.Clean("/definitely/does/not/exist/anywhere/x.txt") {
		t.Fatalf("unresolvable path must keep its lexical form, got %q", got)
	}
}

// The graph provisioning feature links only graph.json, so query cache files
// remain local while a typed write through that file resolves into the base repo.
func TestContainmentRefusesLinkedGraphFileButNotRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	root := t.TempDir()
	ionDir := filepath.Join(root, "ion")
	repo := filepath.Join(root, "repo")
	worktree := filepath.Join(root, "wt")
	for _, d := range []string{ionDir, filepath.Join(repo, "graphify-out"), filepath.Join(worktree, "graphify-out")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	graph := filepath.Join(repo, "graphify-out", "graph.json")
	if err := os.WriteFile(graph, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	linkedGraph := filepath.Join(worktree, "graphify-out", "graph.json")
	if err := os.Symlink(graph, linkedGraph); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}
	writeWorktreeRegistry(t, ionDir, []WorktreeEntry{{WorktreePath: worktree, RepoPath: repo}})
	c := NewCheckerAt(ionDir)

	if r := c.Check("Write", writeInput(linkedGraph), worktree); r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("write through linked graph must be refused, got %+v", r)
	}
	if r := c.Check("Read", writeInput(linkedGraph), worktree); r != nil {
		t.Fatalf("read tools are ungated, got %+v", r)
	}
}
