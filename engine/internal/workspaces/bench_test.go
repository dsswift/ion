package workspaces

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ─── Real-git bench fixture ──────────────────────────────────────────────────
//
// The bench rules depend on git behaviour (MERGE_HEAD, unmerged index entries,
// range diffs), so these tests run against real repositories rather than mocks.

type benchFixture struct {
	ionDir    string
	repo      string
	benchPath string
	checker   *Checker
}

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return string(out)
}

// gitTry runs git expecting possible failure (conflicted merges).
func gitTry(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	return cmd.Run()
}

func newBenchFixture(t *testing.T) *benchFixture {
	t.Helper()
	root := t.TempDir()
	ionDir := filepath.Join(root, "ion-home")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// The bench is a real repo standing in for the assembled worktree.
	benchPath := filepath.Join(root, "integration", "project-main")
	if err := os.MkdirAll(benchPath, 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, benchPath, "init", "-b", "main")
	gitRun(t, benchPath, "config", "user.email", "dev@example.com")
	gitRun(t, benchPath, "config", "user.name", "Dev")
	gitRun(t, benchPath, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(benchPath, "shared.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, benchPath, "add", "-A")
	gitRun(t, benchPath, "commit", "-m", "base")

	f := &benchFixture{ionDir: ionDir, repo: filepath.Join(root, "repo"), benchPath: benchPath}
	f.writeWorkspaces(t, nil)
	f.checker = NewCheckerAt(ionDir)
	return f
}

func (f *benchFixture) writeWorkspaces(t *testing.T, members []BenchMember) {
	t.Helper()
	baseSha := ""
	if out, err := runGit(f.benchPath, "rev-list", "--max-parents=0", "HEAD"); err == nil {
		baseSha = strings.TrimSpace(out)
	}
	payload := map[string]any{"version": 1, "workspaces": []map[string]any{{
		"repoPath": f.repo, "sourceBranch": "main", "benchPath": f.benchPath,
		"baseSha": baseSha, "members": members,
	}}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.ionDir, "integration-workspaces.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// startConflictedMerge leaves a real merge in progress in the bench.
func (f *benchFixture) startConflictedMerge(t *testing.T) {
	t.Helper()
	gitRun(t, f.benchPath, "switch", "-c", "feature")
	if err := os.WriteFile(filepath.Join(f.benchPath, "shared.txt"), []byte("feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "feature side")
	gitRun(t, f.benchPath, "switch", "main")
	if err := os.WriteFile(filepath.Join(f.benchPath, "shared.txt"), []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "main side")
	if err := gitTry(f.benchPath, "merge", "--no-ff", "-m", "conflicted", "feature"); err == nil {
		t.Fatal("expected the merge to conflict")
	}
}

// ─── Bench history rules ─────────────────────────────────────────────────────

func TestWorkspaceBenchRefusesHistoryWrites(t *testing.T) {
	f := newBenchFixture(t)

	for _, cmd := range []string{
		"git commit -m x",
		"git push origin HEAD",
		"git pull",
		"git rebase main",
		"git cherry-pick abc123",
		"git reset --hard HEAD~1",
		"git stash",
		"git tag v1",
		"git switch -c other",
		"git add -A && git commit -m x", // chained: refused on the commit
	} {
		r := f.checker.Check("Bash", bashInput(cmd), f.benchPath)
		if r == nil || r.Kind != RefusalBenchHistory {
			t.Fatalf("%q must be refused in a bench, got %+v", cmd, r)
		}
	}
}

func TestWorkspaceBenchPassesReadsBuildsAndStaging(t *testing.T) {
	f := newBenchFixture(t)

	for _, cmd := range []string{
		"git status --short",
		"git log --oneline -5",
		"git diff HEAD",
		"git add -A",
		"git apply /tmp/x.patch",
		"npm test",
		"make build && make test",
	} {
		if r := f.checker.Check("Bash", bashInput(cmd), f.benchPath); r != nil {
			t.Fatalf("%q must pass in a bench (build/test is its purpose), got %+v", cmd, r)
		}
	}
}

func TestWorkspaceBenchHistoryRefusedInSubdirectory(t *testing.T) {
	f := newBenchFixture(t)
	sub := filepath.Join(f.benchPath, "desktop", "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	r := f.checker.Check("Bash", bashInput("git commit -m x"), sub)
	if r == nil || r.Kind != RefusalBenchHistory {
		t.Fatalf("bench subdirectory must be contained, got %+v", r)
	}
}

func TestWorkspaceBenchHistoryPassesOutsideBench(t *testing.T) {
	f := newBenchFixture(t)

	if r := f.checker.Check("Bash", bashInput("git commit -m x"), f.repo); r != nil {
		t.Fatalf("commit outside the bench refused: %+v", r)
	}
	// A sibling sharing the bench path prefix is not the bench.
	if r := f.checker.Check("Bash", bashInput("git commit -m x"), f.benchPath+"-other"); r != nil {
		t.Fatalf("prefix-sharing sibling refused: %+v", r)
	}
}

// ─── Bench write rules ───────────────────────────────────────────────────────

func TestWorkspaceBenchRefusesFileWrites(t *testing.T) {
	f := newBenchFixture(t)

	r := f.checker.Check("Write", writeInput(filepath.Join(f.benchPath, "shared.txt")), f.benchPath)
	if r == nil || r.Kind != RefusalBenchWrite {
		t.Fatalf("expected bench_write refusal, got %+v", r)
	}
	if !strings.Contains(r.Reason, "destroyed by the next assembly") {
		t.Fatalf("reason must explain the ephemerality: %s", r.Reason)
	}
}

// The TARGET decides, not the cwd: a conversation running elsewhere that
// writes into a bench must still be refused.
func TestWorkspaceBenchRefusesWriteTargetedFromOutside(t *testing.T) {
	f := newBenchFixture(t)

	r := f.checker.Check("Write", writeInput(filepath.Join(f.benchPath, "shared.txt")), "/tmp")
	if r == nil || r.Kind != RefusalBenchWrite {
		t.Fatalf("bench write from outside cwd must be refused, got %+v", r)
	}
}

// Owner attribution asks about each member's contribution RANGE, never its
// tip commit: a collider whose tip touches only an unrelated file while an
// earlier commit in its range touches the target must still be named.
func TestWorkspaceBenchAttributesOwnersByRange(t *testing.T) {
	f := newBenchFixture(t)

	// Member branch: commit 1 touches shared.txt, commit 2 (the tip) touches
	// an unrelated file.
	gitRun(t, f.benchPath, "switch", "-c", "wt/member-a")
	if err := os.WriteFile(filepath.Join(f.benchPath, "shared.txt"), []byte("from member\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "member touches shared")
	if err := os.WriteFile(filepath.Join(f.benchPath, "docs.txt"), []byte("docs only\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "member tip touches docs only")
	pin := strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))
	base := strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "main"))
	gitRun(t, f.benchPath, "switch", "main")

	enabled := true
	f.writeWorkspaces(t, []BenchMember{{
		WorktreePath: "/wt/member-a", BranchName: "wt/member-a",
		Enabled: &enabled, PinnedSha: pin, PinnedBase: base,
	}})

	r := f.checker.Check("Write", writeInput(filepath.Join(f.benchPath, "shared.txt")), f.benchPath)
	if r == nil || r.Kind != RefusalBenchWrite {
		t.Fatalf("expected bench_write refusal, got %+v", r)
	}
	if len(r.Owners) != 1 || r.Owners[0].BranchName != "wt/member-a" {
		t.Fatalf("range attribution must name the member whose RANGE touches the file (tip does not): %+v", r.Owners)
	}
	if !strings.Contains(r.Reason, "/wt/member-a") {
		t.Fatalf("reason must name the owning worktree: %s", r.Reason)
	}
}

// ─── Resolve-once carve-out lifecycle ────────────────────────────────────────

func TestWorkspaceBenchCarveOutLifecycle(t *testing.T) {
	f := newBenchFixture(t)

	// Closed before any merge: driver verbs and edits refused.
	if r := f.checker.Check("Bash", bashInput("git merge --continue"), f.benchPath); r == nil {
		t.Fatal("merge --continue must be refused with no merge open")
	}
	if r := f.checker.Check("Write", writeInput(filepath.Join(f.benchPath, "shared.txt")), f.benchPath); r == nil {
		t.Fatal("bench edit must be refused with no merge open")
	}

	f.startConflictedMerge(t)

	// Open: edits to the UNMERGED path and the driver verbs pass.
	if r := f.checker.Check("Write", writeInput(filepath.Join(f.benchPath, "shared.txt")), f.benchPath); r != nil {
		t.Fatalf("edit to the unmerged path IS the resolution and must pass: %+v", r)
	}
	if r := f.checker.Check("Bash", bashInput("git merge --continue"), f.benchPath); r != nil {
		t.Fatalf("merge --continue drives the open merge and must pass: %+v", r)
	}
	if r := f.checker.Check("Bash", bashInput("git merge --abort"), f.benchPath); r != nil {
		t.Fatalf("merge --abort must pass mid-merge: %+v", r)
	}

	// Scoped tight: a CLEAN path stays refused, a FRESH merge stays refused,
	// other history verbs stay refused — the carve-out is the resolution
	// surface, not the merge state.
	if err := os.WriteFile(filepath.Join(f.benchPath, "clean.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := f.checker.Check("Write", writeInput(filepath.Join(f.benchPath, "clean.txt")), f.benchPath); r == nil {
		t.Fatal("clean-path edit must stay refused mid-merge")
	}
	if r := f.checker.Check("Bash", bashInput("git merge feature"), f.benchPath); r == nil {
		t.Fatal("a fresh merge must stay refused mid-merge")
	}
	if r := f.checker.Check("Bash", bashInput("git commit -m x"), f.benchPath); r == nil {
		t.Fatal("commit must stay refused mid-merge")
	}

	// Closed again after abort.
	gitRun(t, f.benchPath, "merge", "--abort")
	if r := f.checker.Check("Bash", bashInput("git merge --continue"), f.benchPath); r == nil {
		t.Fatal("carve-out must close when the merge ends")
	}
	if r := f.checker.Check("Write", writeInput(filepath.Join(f.benchPath, "shared.txt")), f.benchPath); r == nil {
		t.Fatal("edits must be refused again once the merge ends")
	}
}

// ─── Mid-session bench creation (mtime pin, same defect class as worktrees) ──

func TestWorkspaceSeesBenchCreatedMidSession(t *testing.T) {
	f := newBenchFixture(t)
	newBench := f.benchPath + "-second"

	// Prime the cache with a record that does NOT contain the new bench.
	if r := f.checker.Check("Bash", bashInput("git commit -m x"), newBench); r != nil {
		t.Fatalf("unknown bench refused prematurely: %+v", r)
	}

	time.Sleep(20 * time.Millisecond)
	payload := map[string]any{"version": 1, "workspaces": []map[string]any{
		{"repoPath": f.repo, "sourceBranch": "main", "benchPath": f.benchPath},
		{"repoPath": f.repo, "sourceBranch": "feat", "benchPath": newBench},
	}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.ionDir, "integration-workspaces.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	// No reset. The very next call must refuse.
	if r := f.checker.Check("Bash", bashInput("git commit -m x"), newBench); r == nil {
		t.Fatal("mid-session bench creation invisible to the check")
	}
}
