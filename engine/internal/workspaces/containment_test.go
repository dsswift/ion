package workspaces

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ─── Fixtures ────────────────────────────────────────────────────────────────

const (
	repoPath   = "/repo/project"
	minePath   = "/wt/project-aaa"
	sibling    = "/wt/project-bbb"
	prefixTwin = "/wt/project-aaa0" // shares MINE as a string prefix; different worktree
	otherRepo  = "/repo/other"
)

func writeWorktreeRegistry(t *testing.T, dir string, entries []WorktreeEntry) {
	t.Helper()
	payload := map[string]any{"version": 1, "entries": entries}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "worktree-registry.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func standardRegistry(t *testing.T, dir string) {
	t.Helper()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath},
		{WorktreePath: sibling, RepoPath: repoPath},
		{WorktreePath: prefixTwin, RepoPath: otherRepo},
	})
}

func writeInput(path string) map[string]interface{} {
	return map[string]interface{}{"file_path": path}
}

func bashInput(command string) map[string]interface{} {
	return map[string]interface{}{"command": command}
}

// ─── Worktree containment: the writes that must be refused ──────────────────

func TestWorkspaceRefusesWriteIntoBaseRepo(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath)

	if r == nil {
		t.Fatal("expected a refusal for a base-repo write from a worktree cwd")
	}
	if r.Kind != RefusalBaseRepo {
		t.Fatalf("kind = %s, want base_repo", r.Kind)
	}
	// The refusal names the remediation, or the model just retries.
	if !contains(r.Reason, minePath) {
		t.Fatalf("reason must name the worktree to write in: %s", r.Reason)
	}
}

func TestWorkspaceRefusesWriteIntoSiblingWorktree(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	r := c.Check("Edit", writeInput(filepath.Join(sibling, "y.ts")), minePath)

	if r == nil || r.Kind != RefusalSiblingWorktree {
		t.Fatalf("expected sibling_worktree refusal, got %+v", r)
	}
}

func TestWorkspaceRefusesRelativePathEscapingIntoBaseRepo(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: "/repo/wt-a", RepoPath: "/repo"},
	})
	c := NewCheckerAt(dir)

	// A relative traversal that resolves into the base repo must be judged by
	// its RESOLVED path, not its literal spelling.
	r := c.Check("Write", writeInput("../main.go"), "/repo/wt-a")

	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("expected base_repo refusal for ../ escape, got %+v", r)
	}
}

// ─── Worktree containment: the writes that must pass ────────────────────────

func TestWorkspacePassesWritesInsideOwnWorktree(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	if r := c.Check("Write", writeInput(filepath.Join(minePath, "deep/nested/x.go")), minePath); r != nil {
		t.Fatalf("own-worktree write refused: %+v", r)
	}
}

func TestWorkspaceIsNotACwdJail(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	// /tmp, the Ion home, and unrelated repos are all legitimate targets.
	for _, target := range []string{"/tmp/scratch.txt", "/home/dev/.ion/engine.json", "/somewhere/else/x.md"} {
		if r := c.Check("Write", writeInput(target), minePath); r != nil {
			t.Fatalf("write to %s refused; the check is not a cwd jail: %+v", target, r)
		}
	}
}

func TestWorkspacePassesEverythingOutsideAWorktree(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	// A conversation running IN the base repo is not a worktree conversation.
	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), repoPath); r != nil {
		t.Fatalf("plain repo conversation refused: %+v", r)
	}
}

func TestWorkspacePassesReadAndDispatchTools(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	for _, tool := range []string{"Read", "Grep", "Glob", "Agent", "WebFetch"} {
		if r := c.Check(tool, writeInput(filepath.Join(repoPath, "x.go")), minePath); r != nil {
			t.Fatalf("read tool %s refused: %+v", tool, r)
		}
	}
}

// A sibling whose path merely STARTS WITH the worktree path must not match —
// prefix comparison without the separator refuses real work in an unrelated
// directory, which is worse than the guard not firing.
func TestWorkspaceDoesNotMatchPrefixSharingSibling(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	// prefixTwin belongs to otherRepo. Writing there from minePath is neither
	// the base repo nor a same-repo sibling — it must pass.
	if r := c.Check("Write", writeInput(filepath.Join(prefixTwin, "z.go")), minePath); r != nil {
		t.Fatalf("prefix-sharing directory of another repo refused: %+v", r)
	}
	// And a cwd inside prefixTwin resolves to ITS registration, not minePath's.
	got := c.Resolve(prefixTwin)
	if got.Worktree == nil || got.Worktree.RepoPath != otherRepo {
		t.Fatalf("prefix twin resolved wrong: %+v", got.Worktree)
	}
}

func TestWorkspaceSiblingSetIsSameRepoOnly(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	got := c.Resolve(minePath)
	if got.Worktree == nil {
		t.Fatal("expected worktree containment")
	}
	if len(got.Worktree.SiblingPaths) != 1 || got.Worktree.SiblingPaths[0] != sibling {
		t.Fatalf("siblings = %v, want exactly [%s]", got.Worktree.SiblingPaths, sibling)
	}
}

// ─── Registry: fail-open and the mid-session mtime pin ──────────────────────

func TestWorkspaceFailsOpenOnMissingRegistry(t *testing.T) {
	c := NewCheckerAt(t.TempDir())
	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath); r != nil {
		t.Fatalf("missing registry must fail open: %+v", r)
	}
}

func TestWorkspaceFailsOpenOnCorruptRegistry(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "worktree-registry.json"), []byte("{ not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := NewCheckerAt(dir)
	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath); r != nil {
		t.Fatalf("corrupt registry must fail open: %+v", r)
	}
}

func TestWorkspaceIgnoresMalformedEntriesWithoutDiscardingGoodOnes(t *testing.T) {
	dir := t.TempDir()
	raw := `{"version":1,"entries":[null,{"worktreePath":"","repoPath":"/repo"},{"worktreePath":"` + minePath + `"},{"worktreePath":"` + minePath + `","repoPath":"` + repoPath + `"}]}`
	if err := os.WriteFile(filepath.Join(dir, "worktree-registry.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	c := NewCheckerAt(dir)
	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath); r == nil {
		t.Fatal("the one valid entry must still enforce")
	}
}

// THE regression pin for the live incident that moved this mechanism into the
// engine. A conversation running in the base repo was converted to a worktree:
// the client registered the worktree and relocated the session, then the next
// run's Write went into the BASE REPO — and a load-once registry cache found
// no entry for the new cwd, concluded "not a worktree conversation", and
// passed the write. The engine daemon is long-lived; a worktree registered
// mid-session must be visible to the very next tool call. Deliberately no
// cache reset between the two reads — the mtime check is what must notice.
func TestWorkspaceSeesWorktreeRegisteredMidSession(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath},
	})
	c := NewCheckerAt(dir)

	// Prime the cache with a registry that does NOT contain the new worktree.
	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), "/wt/brand-new"); r != nil {
		t.Fatalf("unregistered cwd refused prematurely: %+v", r)
	}

	// The convert flow registers the worktree. Nudge the clock so mtime moves
	// even on a coarse-granularity filesystem.
	time.Sleep(20 * time.Millisecond)
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath},
		{WorktreePath: "/wt/brand-new", RepoPath: repoPath},
	})

	// No reset. The very next call must refuse the base-repo write.
	r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), "/wt/brand-new")
	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("mid-session registration invisible to the check: %+v", r)
	}
}

// The inverse direction: retiring a worktree un-registers it, and a kept stale
// entry would falsely refuse work in a directory that is no longer a worktree.
func TestWorkspaceDropsWorktreeRetiredMidSession(t *testing.T) {
	dir := t.TempDir()
	standardRegistry(t, dir)
	c := NewCheckerAt(dir)

	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath); r == nil {
		t.Fatal("expected the primed refusal")
	}

	time.Sleep(20 * time.Millisecond)
	writeWorktreeRegistry(t, dir, []WorktreeEntry{})

	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath); r != nil {
		t.Fatalf("retired worktree still enforced: %+v", r)
	}
}

// A corrupt write is never cached: the next read after the file is repaired
// must see the repaired content even if mtime were somehow equal — and more
// importantly, the corrupt read itself must not pin an empty view forever.
func TestWorkspaceCorruptRegistryIsNotCached(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "worktree-registry.json"), []byte("{ half-written"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := NewCheckerAt(dir)
	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath); r != nil {
		t.Fatalf("corrupt read must fail open: %+v", r)
	}

	time.Sleep(20 * time.Millisecond)
	standardRegistry(t, dir)

	if r := c.Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath); r == nil {
		t.Fatal("repaired registry must enforce on the next call")
	}
}

// A nil Checker is the disabled state and passes everything (the run loop
// threads nil when SecurityConfig turns the feature off).
func TestWorkspaceNilCheckerPassesEverything(t *testing.T) {
	var c *Checker
	if r := c.Check("Write", writeInput("/repo/x.go"), "/wt/a"); r != nil {
		t.Fatalf("nil checker must pass: %+v", r)
	}
}

// ─── Landed worktree sealing ────────────────────────────────────────────────

func landedRegistry(t *testing.T, dir string) {
	t.Helper()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{
		{WorktreePath: minePath, RepoPath: repoPath, BranchName: "wt/mine", LandedAt: 1700000500000},
		{WorktreePath: sibling, RepoPath: repoPath},
	})
}

func TestLandedWorktreeRefusesWriteInsideOwnWorktree(t *testing.T) {
	dir := t.TempDir()
	landedRegistry(t, dir)
	c := NewCheckerAt(dir)

	r := c.Check("Write", writeInput(filepath.Join(minePath, "x.go")), minePath)

	if r == nil {
		t.Fatal("a landed worktree must refuse Write even inside itself")
	}
	if r.Kind != RefusalLandedWorktree {
		t.Fatalf("kind = %s, want landed_worktree", r.Kind)
	}
	if !contains(r.Reason, "sealed") {
		t.Errorf("reason must say sealed: %s", r.Reason)
	}
}

func TestLandedWorktreeRefusesEditInsideOwnWorktree(t *testing.T) {
	dir := t.TempDir()
	landedRegistry(t, dir)
	c := NewCheckerAt(dir)

	r := c.Check("Edit", writeInput(filepath.Join(minePath, "y.go")), minePath)

	if r == nil || r.Kind != RefusalLandedWorktree {
		t.Fatalf("Edit in landed worktree must be refused, got %+v", r)
	}
}

func TestLandedWorktreeRefusesNotebookEdit(t *testing.T) {
	dir := t.TempDir()
	landedRegistry(t, dir)
	c := NewCheckerAt(dir)

	r := c.Check("NotebookEdit", writeInput(filepath.Join(minePath, "n.ipynb")), minePath)

	if r == nil || r.Kind != RefusalLandedWorktree {
		t.Fatalf("NotebookEdit in landed worktree must be refused, got %+v", r)
	}
}

func TestLandedWorktreeRefusesBash(t *testing.T) {
	dir := t.TempDir()
	landedRegistry(t, dir)
	c := NewCheckerAt(dir)

	r := c.Check("Bash", bashInput("echo hi"), minePath)

	if r == nil || r.Kind != RefusalLandedWorktree {
		t.Fatalf("Bash in landed worktree must be refused, got %+v", r)
	}
}

func TestLandedWorktreePassesReadTools(t *testing.T) {
	dir := t.TempDir()
	landedRegistry(t, dir)
	c := NewCheckerAt(dir)

	for _, tool := range []string{"Read", "Grep", "Glob", "Agent"} {
		if r := c.Check(tool, writeInput(filepath.Join(minePath, "x.go")), minePath); r != nil {
			t.Fatalf("read tool %s refused in landed worktree: %+v", tool, r)
		}
	}
}

func TestUnlandedWorktreePassesWriteInsideItself(t *testing.T) {
	dir := t.TempDir()
	landedRegistry(t, dir)
	c := NewCheckerAt(dir)

	// sibling has no LandedAt -- writing inside it must pass.
	if r := c.Check("Write", writeInput(filepath.Join(sibling, "ok.go")), sibling); r != nil {
		t.Fatalf("unlanded sibling must allow writes inside itself: %+v", r)
	}
}

func TestLandedWorktreeFailsOpenOnMissingRegistry(t *testing.T) {
	c := NewCheckerAt(t.TempDir())

	if r := c.Check("Write", writeInput(filepath.Join(minePath, "x.go")), minePath); r != nil {
		t.Fatalf("missing registry must fail open (no landed refusal): %+v", r)
	}
}

func TestLandedWorktreeReasonIncludesBranch(t *testing.T) {
	dir := t.TempDir()
	landedRegistry(t, dir)
	c := NewCheckerAt(dir)

	r := c.Check("Write", writeInput(filepath.Join(minePath, "x.go")), minePath)

	if r == nil {
		t.Fatal("expected landed refusal")
	}
	if !contains(r.Reason, "wt/mine") {
		t.Errorf("reason must include branch name: %s", r.Reason)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
