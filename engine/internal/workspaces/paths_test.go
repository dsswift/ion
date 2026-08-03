package workspaces

// Path handling: canonicalization, traversal rejection, and symlink resolution.
//
// Every rule in this package is a comparison between a path and a root, so a
// path that has two spellings has two verdicts. These tests pin both directions
// of that failure: a symlinked route into a protected root must still be
// recognized (or the guard is bypassable by `ln -s`), and a traversal out of a
// bench must be rejected by attribution (or it answers about files it has no
// business answering about).

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// ─── Attribution path rejection ──────────────────────────────────────────────

func TestAttributionRejectsTraversalEscapingTheBench(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	res := f.attribute(AttributionRequest{Path: "../../etc/passwd"})

	if res.Rejection == "" {
		t.Fatalf("a traversal out of the bench must be rejected: %s", describeResult(res))
	}
	if res.Outcome != OutcomeUnknown {
		t.Fatalf("a rejected request has no outcome but unknown, got %s", res.Outcome)
	}
	if !strings.Contains(res.Rejection, "escapes the bench") {
		t.Errorf("the rejection must name the cause, got %q", res.Rejection)
	}
	// No candidate work may have happened: a rejected path must not have run git
	// against a file outside the bench.
	if len(res.Candidates) != 0 {
		t.Errorf("a rejected request must not gather candidates: %s", describeResult(res))
	}
}

func TestAttributionRejectsAbsolutePathOutsideTheBench(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	res := f.attribute(AttributionRequest{Path: filepath.Join(t.TempDir(), "elsewhere.txt")})

	if res.Rejection == "" || !strings.Contains(res.Rejection, "outside the bench") {
		t.Fatalf("an absolute path outside the bench must be rejected as such: %q", res.Rejection)
	}
}

func TestAttributionRejectsNonBenchRequest(t *testing.T) {
	f := newAttrFixture(t)
	dir := t.TempDir()

	res := f.checker.Attribute(context.Background(), AttributionRequest{BenchPath: dir, Path: "x.go"})

	if res.Rejection == "" || !strings.Contains(res.Rejection, "not inside a registered integration bench") {
		t.Fatalf("attribution outside a bench must be rejected with that reason: %q", res.Rejection)
	}
}

func TestAttributionRejectsTheBenchRootItself(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	res := f.attribute(AttributionRequest{Path: f.benchPath})

	if res.Rejection == "" {
		t.Fatalf("the bench root is a directory, not an attributable file: %s", describeResult(res))
	}
}

// ─── Line-range validation ───────────────────────────────────────────────────

// An inverted range is REJECTED rather than silently widened to the whole file:
// answering about the entire file would look like a successful answer to the
// question the caller thinks they asked.
func TestAttributionRejectsInvertedLineRange(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: 9, EndLine: 3})

	if res.Rejection == "" || !strings.Contains(res.Rejection, "before startLine") {
		t.Fatalf("an inverted range must be rejected, not widened: %q", res.Rejection)
	}
}

func TestAttributionRejectsEndLineWithoutStart(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	res := f.attribute(AttributionRequest{Path: "app.txt", EndLine: 5})

	if res.Rejection == "" || !strings.Contains(res.Rejection, "without a startLine") {
		t.Fatalf("endLine alone must be rejected: %q", res.Rejection)
	}
}

func TestAttributionRejectsNegativeLineNumbers(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: -4})

	if res.Rejection == "" || !strings.Contains(res.Rejection, "1-based") {
		t.Fatalf("a negative line number must be rejected: %q", res.Rejection)
	}
}

// A single StartLine means exactly that line, and the echoed range says so.
func TestAttributionTreatsSingleStartLineAsOneLine(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/beta")

	line := f.lineOf(t, "app.txt", "line 08 changed by alpha")
	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: line})

	if res.RequestedLines == nil {
		t.Fatal("the validated line scope must be echoed back")
	}
	if res.RequestedLines.Start != line || res.RequestedLines.End != line {
		t.Fatalf("a bare startLine is a single line, got %+v", *res.RequestedLines)
	}
}

// ─── Symlink resolution: the guard must not be bypassable by `ln -s` ─────────

// A write reached through a symlink into a bench is still a bench write.
// Without canonicalization the symlinked path is string-unequal to the recorded
// bench path, the check concludes "not a bench", and the write lands in a
// directory the next assembly destroys.
func TestContainmentResolvesSymlinkIntoBench(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	f := newBenchFixture(t)

	link := filepath.Join(t.TempDir(), "bench-link")
	if err := os.Symlink(f.benchPath, link); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}

	r := f.checker.Check("Write", writeInput(filepath.Join(link, "shared.txt")), "/tmp")

	if r == nil || r.Kind != RefusalBenchWrite {
		t.Fatalf("a symlinked route into the bench must still be refused, got %+v", r)
	}
}

// The same in the other direction: a symlinked CWD must still classify as the
// bench, so the bench history rules apply.
func TestContainmentResolvesSymlinkedCwdToBench(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	f := newBenchFixture(t)

	link := filepath.Join(t.TempDir(), "bench-link")
	if err := os.Symlink(f.benchPath, link); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}

	r := f.checker.Check("Bash", bashInput("git commit -m x"), link)

	if r == nil || r.Kind != RefusalBenchHistory {
		t.Fatalf("a symlinked bench cwd must be contained, got %+v", r)
	}
}

// A symlink into a worktree's BASE REPO is likewise still the base repo.
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
	f := newBenchFixture(t)

	elsewhere := t.TempDir()
	link := filepath.Join(t.TempDir(), "safe-link")
	if err := os.Symlink(elsewhere, link); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}

	if r := f.checker.Check("Write", writeInput(filepath.Join(link, "x.txt")), f.benchPath); r != nil {
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

func TestResolveWithinRejectsOutsideAndTraversal(t *testing.T) {
	root := t.TempDir()

	if _, _, rej := resolveWithin(filepath.Join(root, "sub", "f.txt"), root); rej != "" {
		t.Fatalf("a contained path must be accepted, got %q", rej)
	}
	// Deliberately NOT filepath.Join: Join cleans, and cleaning erases the `..`
	// that distinguishes a traversal from a plainly external path. Callers pass
	// raw spellings for the same reason.
	if _, _, rej := resolveWithin(root+"/../f.txt", root); rej != rejectTraversal {
		t.Fatalf("a traversal must be reported as such, got %q", rej)
	}
	// A `..` inside a FILENAME is not a traversal segment.
	if _, _, rej := resolveWithin(filepath.Join(root, "notes..txt"), root); rej != "" {
		t.Fatalf("a filename containing dots must not read as a traversal, got %q", rej)
	}
	if _, _, rej := resolveWithin("relative/path.txt", root); rej != rejectRelative {
		t.Fatalf("a relative path must be reported as such, got %q", rej)
	}
	if _, _, rej := resolveWithin("", root); rej != rejectEmpty {
		t.Fatalf("an empty path must be reported as such, got %q", rej)
	}
	if _, _, rej := resolveWithin("/tmp/x\x00y", root); rej != rejectNulByte {
		t.Fatalf("a NUL byte must be reported as such, got %q", rej)
	}
	if _, _, rej := resolveWithin(root, root); rej != rejectOutside {
		t.Fatalf("the root itself is not a file within it, got %q", rej)
	}
}
