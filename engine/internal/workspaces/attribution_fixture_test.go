package workspaces

// Real-git attribution fixture.
//
// Attribution's whole value is that it answers correctly in the cases a
// plausible-looking shortcut gets wrong: a line pushed down by an earlier
// member, a member whose TIP touches a different file than the commit that
// introduced the problem, two members in one file, a conflict resolution that
// belongs to neither side. None of those are reproducible against a mocked git
// runner — they are properties of blame, merge commits, and ancestry — so the
// fixture assembles a real bench from real member branches and asks the real
// questions.
//
// The layout every test below shares:
//
//	main (source)      app.txt with 12 numbered lines, source_only.txt
//	  ├── wt/alpha     edits app.txt line 8; tip commit touches alpha_only.txt
//	  ├── wt/beta      inserts 5 lines at the TOP of app.txt (shifts alpha's
//	  │                edit from line 8 to line 13 in the assembly)
//	  └── wt/gamma     edits app.txt line 3 — a second owner in one file
//	bench              base=main, merges alpha then beta (then gamma when asked)
//
// The shift is the point: alpha's line is at 8 in its own branch and 13 in the
// bench, so an answer derived from alpha's diff coordinates names the wrong
// line, and only blame over the assembled tree gets it right.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type attrFixture struct {
	ionDir    string
	repo      string
	benchPath string
	checker   *Checker
	baseSha   string
	// pins maps a member branch to its pinned tip after buildMembers.
	pins map[string]string
}

// appLines is the source file every member edits, numbered so a shifted line is
// visibly the same content at a different position.
func appLines() []string {
	var lines []string
	for i := 1; i <= 12; i++ {
		lines = append(lines, fmt.Sprintf("line %02d", i))
	}
	return lines
}

func writeLines(t *testing.T, path string, lines []string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
}

func newAttrFixture(t *testing.T) *attrFixture {
	t.Helper()
	root := t.TempDir()
	ionDir := filepath.Join(root, "ion-home")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	benchPath := filepath.Join(root, "integration", "project-main")
	if err := os.MkdirAll(benchPath, 0o755); err != nil {
		t.Fatal(err)
	}

	gitRun(t, benchPath, "init", "-b", "main")
	gitRun(t, benchPath, "config", "user.email", "dev@example.com")
	gitRun(t, benchPath, "config", "user.name", "Dev")
	gitRun(t, benchPath, "config", "commit.gpgsign", "false")
	// The fixture must not inherit the developer's global excludes. A machine
	// whose ~/.gitignore lists `*.bin` (a common ML-model entry) would silently
	// drop the binary fixture file and the binary test would fail only on that
	// machine — the exact class of machine-dependent failure a fixture exists to
	// avoid. Repository-local config, so nothing outside the temp dir is touched.
	gitRun(t, benchPath, "config", "core.excludesFile", filepath.Join(root, "empty-global-excludes"))
	// Rename detection is what the rename test asserts; a repository-local
	// setting keeps it from depending on the operator's diff config.
	gitRun(t, benchPath, "config", "diff.renames", "true")

	writeLines(t, filepath.Join(benchPath, "app.txt"), appLines())
	writeLines(t, filepath.Join(benchPath, "source_only.txt"), []string{"owned by the source branch"})
	gitRun(t, benchPath, "add", "-A")
	gitRun(t, benchPath, "commit", "-m", "source: initial")

	f := &attrFixture{
		ionDir:    ionDir,
		repo:      filepath.Join(root, "repo"),
		benchPath: benchPath,
		baseSha:   strings.TrimSpace(gitRun(t, benchPath, "rev-parse", "HEAD")),
		pins:      map[string]string{},
	}
	f.checker = NewCheckerAt(ionDir)
	return f
}

// buildMembers creates the three member branches and records their pins.
func (f *attrFixture) buildMembers(t *testing.T) {
	t.Helper()
	app := filepath.Join(f.benchPath, "app.txt")

	// alpha: edits line 8, then a tip commit that touches a DIFFERENT file.
	// The tip-only shortcut fails here — the tip does not touch app.txt at all.
	gitRun(t, f.benchPath, "switch", "-c", "wt/alpha", f.baseSha)
	lines := readLines(t, app)
	lines[7] = "line 08 changed by alpha"
	writeLines(t, app, lines)
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "alpha: edit line 8")
	writeLines(t, filepath.Join(f.benchPath, "alpha_only.txt"), []string{"alpha"})
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "alpha: tip touches only alpha_only.txt")
	f.pins["wt/alpha"] = strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))

	// beta: inserts 5 lines at the TOP, shifting every later line down by 5.
	gitRun(t, f.benchPath, "switch", "-c", "wt/beta", f.baseSha)
	lines = readLines(t, app)
	prefix := []string{"beta header 1", "beta header 2", "beta header 3", "beta header 4", "beta header 5"}
	writeLines(t, app, append(prefix, lines...))
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "beta: insert 5 header lines")
	f.pins["wt/beta"] = strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))

	// gamma: edits line 3 — a second owner inside one file, far from alpha's.
	gitRun(t, f.benchPath, "switch", "-c", "wt/gamma", f.baseSha)
	lines = readLines(t, app)
	lines[2] = "line 03 changed by gamma"
	writeLines(t, app, lines)
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "gamma: edit line 3")
	f.pins["wt/gamma"] = strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))

	gitRun(t, f.benchPath, "switch", "main")
}

// assemble builds the bench branch by merging each named member in order, and
// writes the workspace record with those pins. Mirrors what the real assembly
// does: base first, then each enabled member's pinned tip.
func (f *attrFixture) assemble(t *testing.T, branches ...string) {
	t.Helper()
	gitRun(t, f.benchPath, "switch", "-C", "ion/bench/main", f.baseSha)
	for _, branch := range branches {
		gitRun(t, f.benchPath, "merge", "--no-ff", "-m", "assembly: merge "+branch, f.pins[branch])
	}

	var members []map[string]any
	for _, branch := range branches {
		members = append(members, map[string]any{
			"worktreePath":  "/wt/" + strings.TrimPrefix(branch, "wt/"),
			"branchName":    branch,
			"enabled":       true,
			"pin":           "current",
			"merge":         "merged",
			"pinnedSha":     f.pins[branch],
			"pinnedBaseSha": f.baseSha,
		})
	}
	f.writeRecord(t, members, nil)
}

// writeRecord writes the integration-workspaces record. extra merges additional
// top-level workspace keys so a test can set lastAssembly and friends.
func (f *attrFixture) writeRecord(t *testing.T, members []map[string]any, extra map[string]any) {
	t.Helper()
	workspace := map[string]any{
		"repoPath":     f.repo,
		"sourceBranch": "main",
		"benchPath":    f.benchPath,
		"benchBranch":  "ion/bench/main",
		"baseSha":      f.baseSha,
		"lastAssembly": "assembled",
		"members":      members,
	}
	for k, v := range extra {
		workspace[k] = v
	}
	payload := map[string]any{"version": 1, "workspaces": []map[string]any{workspace}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.ionDir, "integration-workspaces.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeWorktreeEntries seeds the worktree registry so titles and non-member
// worktrees exist.
func (f *attrFixture) writeWorktreeEntries(t *testing.T, entries []map[string]any) {
	t.Helper()
	payload := map[string]any{"version": 1, "entries": entries}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.ionDir, "worktree-registry.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// lineOf returns the 1-based line number in the assembled bench file whose
// content matches want. Tests locate lines by CONTENT, never by a hardcoded
// number: a hardcoded number would silently start asserting about the wrong
// line the moment the fixture's shape changed, which is the exact defect
// attribution exists to prevent.
func (f *attrFixture) lineOf(t *testing.T, relPath, want string) int {
	t.Helper()
	for i, line := range readLines(t, filepath.Join(f.benchPath, relPath)) {
		if strings.Contains(line, want) {
			return i + 1
		}
	}
	t.Fatalf("no line containing %q in the assembled %s: %v", want, relPath, readLines(t, filepath.Join(f.benchPath, relPath)))
	return 0
}

func (f *attrFixture) attribute(req AttributionRequest) AttributionResult {
	if req.BenchPath == "" {
		req.BenchPath = f.benchPath
	}
	return f.checker.Attribute(context.Background(), req)
}

// candidateFor finds a result candidate by branch name.
func candidateFor(t *testing.T, res AttributionResult, branch string) AttributionCandidate {
	t.Helper()
	for _, c := range res.Candidates {
		if c.BranchName == branch {
			return c
		}
	}
	t.Fatalf("no candidate for %s in %s", branch, describeResult(res))
	return AttributionCandidate{}
}

func hasCandidate(res AttributionResult, branch string) bool {
	for _, c := range res.Candidates {
		if c.BranchName == branch {
			return true
		}
	}
	return false
}

// describeResult renders a result compactly for failure messages. A failing
// attribution test is unreadable without seeing the outcome, candidates, and
// errors together.
func describeResult(res AttributionResult) string {
	var b strings.Builder
	fmt.Fprintf(&b, "outcome=%s path=%s lineScoped=%v", res.Outcome, res.Path, res.LineScoped)
	if res.Rejection != "" {
		fmt.Fprintf(&b, " rejection=%q", res.Rejection)
	}
	for _, c := range res.Candidates {
		fmt.Fprintf(&b, "\n  candidate %s status=%s changed=%v matched=%v err=%q",
			c.BranchName, c.Status, c.ChangedRanges, c.MatchedLines, c.Error)
	}
	if len(res.SourceLines) > 0 {
		fmt.Fprintf(&b, "\n  sourceLines=%v", res.SourceLines)
	}
	if len(res.ResolutionLines) > 0 {
		fmt.Fprintf(&b, "\n  resolutionLines=%v", res.ResolutionLines)
	}
	if len(res.UnknownLines) > 0 {
		fmt.Fprintf(&b, "\n  unknownLines=%v", res.UnknownLines)
	}
	for _, e := range res.Errors {
		fmt.Fprintf(&b, "\n  error: %s", e)
	}
	return b.String()
}

// rangesContain reports whether any span covers line.
func rangesContain(ranges []LineRange, line int) bool {
	for _, r := range ranges {
		if line >= r.Start && line <= r.End {
			return true
		}
	}
	return false
}
