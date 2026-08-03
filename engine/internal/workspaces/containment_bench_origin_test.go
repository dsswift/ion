package workspaces

// Bench-origin write destinations: which directories a conversation running IN a
// bench may write to.
//
// The rule these tests pin exists because the bench write refusal names its own
// remediation — "make the change at <member worktree>, commit it there, then
// update that member". A conversation diagnosing an assembled failure runs in
// the bench, because that is where the failing build is. If bench-origin writes
// were refused everywhere outside the bench, the remediation the guard prints
// would itself be refused and the rule would have no compliant path at all.
//
// So the permission is scoped to exactly the worktrees whose content is in the
// bench: enrolled AND enabled. The four negative cases below are the boundary.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// benchDestFixture is a bench plus a repo, an enabled member, a disabled
// member, and a non-member worktree of the same repo.
type benchDestFixture struct {
	ionDir    string
	repo      string
	benchPath string
	enabled   string
	disabled  string
	nonMember string
	otherRepo string
	checker   *Checker
}

func newBenchDestFixture(t *testing.T) *benchDestFixture {
	t.Helper()
	root := t.TempDir()
	f := &benchDestFixture{
		ionDir:    filepath.Join(root, "ion"),
		repo:      filepath.Join(root, "source", "project"),
		benchPath: filepath.Join(root, "ion", "integration", "project-main"),
		enabled:   filepath.Join(root, "ion", "worktrees", "project-enabled"),
		disabled:  filepath.Join(root, "ion", "worktrees", "project-disabled"),
		nonMember: filepath.Join(root, "ion", "worktrees", "project-nonmember"),
		otherRepo: filepath.Join(root, "source", "unrelated"),
	}
	for _, d := range []string{f.ionDir, f.repo, f.benchPath, f.enabled, f.disabled, f.nonMember, f.otherRepo} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// All three worktrees belong to the same repo; only two are enrolled.
	writeWorktreeRegistry(t, f.ionDir, []WorktreeEntry{
		{WorktreePath: f.enabled, RepoPath: f.repo, BranchName: "wt/enabled"},
		{WorktreePath: f.disabled, RepoPath: f.repo, BranchName: "wt/disabled"},
		{WorktreePath: f.nonMember, RepoPath: f.repo, BranchName: "wt/nonmember"},
	})

	enabled, disabled := true, false
	payload := map[string]any{"version": 1, "workspaces": []map[string]any{{
		"repoPath":     f.repo,
		"sourceBranch": "main",
		"benchPath":    f.benchPath,
		"benchBranch":  "ion/bench/main",
		"members": []BenchMember{
			{WorktreePath: f.enabled, BranchName: "wt/enabled", Enabled: &enabled},
			{WorktreePath: f.disabled, BranchName: "wt/disabled", Enabled: &disabled},
		},
	}}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.ionDir, "integration-workspaces.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	f.checker = NewCheckerAt(f.ionDir)
	return f
}

// ─── The permitted destination ───────────────────────────────────────────────

// The remediation path itself. Without this, the bench refusal names an action
// the guard then refuses.
func TestBenchOriginWriteIntoEnabledMemberPasses(t *testing.T) {
	f := newBenchDestFixture(t)

	for _, tool := range []string{"Write", "Edit", "NotebookEdit"} {
		target := filepath.Join(f.enabled, "src", "fix.go")
		if r := f.checker.Check(tool, writeInput(target), f.benchPath); r != nil {
			t.Fatalf("%s into an enabled member worktree is the remediation the bench refusal names and must pass: %+v", tool, r)
		}
	}
}

// Committing there is half the remediation ("commit it there"), so history verbs
// in an enabled member must pass from a bench conversation too.
func TestBenchOriginCommitInEnabledMemberPasses(t *testing.T) {
	f := newBenchDestFixture(t)

	for _, cmd := range []string{
		"cd " + f.enabled + " && git commit -am fix",
		"git -C " + f.enabled + " commit -am fix",
		"cd " + f.enabled + " && git add -A && git commit -m fix",
	} {
		if r := f.checker.Check("Bash", bashInput(cmd), f.benchPath); r != nil {
			t.Fatalf("%q must pass: committing in the owning member is the remediation: %+v", cmd, r)
		}
	}
}

// ─── The refused destinations ────────────────────────────────────────────────

// A DISABLED member is enrolled but excluded from the assembly, so none of its
// work is in the bench and a failure observed there cannot originate from it.
func TestBenchOriginWriteIntoDisabledMemberRefused(t *testing.T) {
	f := newBenchDestFixture(t)

	r := f.checker.Check("Write", writeInput(filepath.Join(f.disabled, "x.go")), f.benchPath)

	if r == nil || r.Kind != RefusalDisabledMember {
		t.Fatalf("expected a disabled_member refusal, got %+v", r)
	}
	if !strings.Contains(r.Reason, "DISABLED") {
		t.Errorf("the refusal must explain that the member is excluded: %s", r.Reason)
	}
	// The remediation must still be reachable from the message.
	if !strings.Contains(r.Reason, "WorkspaceAttribution") {
		t.Errorf("the refusal must name the attribution tool: %s", r.Reason)
	}
}

// The SOURCE CHECKOUT is never a destination: writing there commits straight
// onto the source branch and bypasses integration entirely.
func TestBenchOriginWriteIntoSourceCheckoutRefused(t *testing.T) {
	f := newBenchDestFixture(t)

	r := f.checker.Check("Write", writeInput(filepath.Join(f.repo, "main.go")), f.benchPath)

	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("expected a base_repo refusal for the source checkout, got %+v", r)
	}
	if !strings.Contains(r.Reason, "source checkout") {
		t.Errorf("the refusal must name what the path is: %s", r.Reason)
	}
	if !strings.Contains(r.Reason, "WorkspaceAttribution") {
		t.Errorf("the refusal must name the attribution tool: %s", r.Reason)
	}
}

// An ARBITRARY worktree of the same repo is enrolled in nothing and owned by
// another conversation — the same interleaving defect worktree isolation exists
// to prevent.
func TestBenchOriginWriteIntoNonMemberWorktreeRefused(t *testing.T) {
	f := newBenchDestFixture(t)

	r := f.checker.Check("Write", writeInput(filepath.Join(f.nonMember, "x.go")), f.benchPath)

	if r == nil || r.Kind != RefusalSiblingWorktree {
		t.Fatalf("expected a sibling_worktree refusal, got %+v", r)
	}
	if !strings.Contains(r.Reason, "NOT enrolled") {
		t.Errorf("the refusal must explain that the worktree is not a member: %s", r.Reason)
	}
}

// Committing in the source checkout from a bench conversation is refused for the
// same reason writing there is.
func TestBenchOriginCommitInSourceCheckoutRefused(t *testing.T) {
	f := newBenchDestFixture(t)

	r := f.checker.Check("Bash", bashInput("cd "+f.repo+" && git commit -am x"), f.benchPath)

	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("expected a base_repo refusal, got %+v", r)
	}
}

func TestBenchOriginCommitInNonMemberWorktreeRefused(t *testing.T) {
	f := newBenchDestFixture(t)

	r := f.checker.Check("Bash", bashInput("git -C "+f.nonMember+" commit -am x"), f.benchPath)

	if r == nil || r.Kind != RefusalSiblingWorktree {
		t.Fatalf("expected a sibling_worktree refusal, got %+v", r)
	}
}

// ─── The bench itself stays refused ──────────────────────────────────────────

// The member-destination permission must not have widened the bench rule. This
// is the regression that would silently undo the whole guard.
func TestBenchOriginWriteIntoBenchStillRefused(t *testing.T) {
	f := newBenchDestFixture(t)

	r := f.checker.Check("Write", writeInput(filepath.Join(f.benchPath, "app.go")), f.benchPath)

	if r == nil || r.Kind != RefusalBenchWrite {
		t.Fatalf("a write into the bench must still be refused, got %+v", r)
	}
	if !strings.Contains(r.Reason, "WorkspaceAttribution") {
		t.Errorf("the bench refusal must name the attribution tool as the precise path: %s", r.Reason)
	}
	if !strings.Contains(r.Reason, "enabled member worktree") {
		t.Errorf("the bench refusal must state that member writes are permitted, or the remediation reads as forbidden: %s", r.Reason)
	}
}

func TestBenchOriginHistoryInBenchStillRefused(t *testing.T) {
	f := newBenchDestFixture(t)

	r := f.checker.Check("Bash", bashInput("git commit -am x"), f.benchPath)

	if r == nil || r.Kind != RefusalBenchHistory {
		t.Fatalf("history inside the bench must still be refused, got %+v", r)
	}
	if !strings.Contains(r.Reason, "WorkspaceAttribution") {
		t.Errorf("the history refusal must name the attribution tool: %s", r.Reason)
	}
}

// ─── Still not a cwd jail ────────────────────────────────────────────────────

// The bench-origin rules govern the repo's own directories. Everything else
// passes, exactly as for a worktree conversation: over-blocking would make bench
// conversations useless for real work.
func TestBenchOriginPassesUnrelatedDestinations(t *testing.T) {
	f := newBenchDestFixture(t)

	for _, target := range []string{
		"/tmp/scratch.txt",
		filepath.Join(f.ionDir, "notes.md"),
		filepath.Join(f.otherRepo, "src", "x.go"),
	} {
		if r := f.checker.Check("Write", writeInput(target), f.benchPath); r != nil {
			t.Fatalf("write to %s must pass; the bench rules are not a cwd jail: %+v", target, r)
		}
	}
}

// A build or test command run outside the bench is not a containment concern:
// only history verbs are judged there.
func TestBenchOriginPassesNonHistoryCommandsOutsideBench(t *testing.T) {
	f := newBenchDestFixture(t)

	for _, cmd := range []string{
		"cd " + f.repo + " && npm test",
		"cd " + f.nonMember + " && git status --short",
		"cd " + f.disabled + " && make build",
	} {
		if r := f.checker.Check("Bash", bashInput(cmd), f.benchPath); r != nil {
			t.Fatalf("%q is a read/build command and must pass: %+v", cmd, r)
		}
	}
}

// ─── Absent `enabled` means enabled ──────────────────────────────────────────

// Enrollment defaults to included, so a member record with no `enabled` key is a
// valid destination. Reading absent as disabled would refuse the remediation for
// every member written by an older client.
func TestBenchOriginTreatsAbsentEnabledAsEnabled(t *testing.T) {
	f := newBenchDestFixture(t)

	payload := map[string]any{"version": 1, "workspaces": []map[string]any{{
		"repoPath": f.repo, "sourceBranch": "main", "benchPath": f.benchPath,
		"members": []map[string]any{
			{"worktreePath": f.enabled, "branchName": "wt/enabled"},
		},
	}}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.ionDir, "integration-workspaces.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	if r := f.checker.Check("Write", writeInput(filepath.Join(f.enabled, "x.go")), f.benchPath); r != nil {
		t.Fatalf("a member with no explicit enabled key is enrolled and writable: %+v", r)
	}
}

// ─── A worktree conversation is unaffected ───────────────────────────────────

// The bench-origin rules apply only when the CWD is a bench. A conversation in
// a member worktree keeps the ordinary worktree rules, including refusing writes
// into another member — two members are still two conversations.
func TestWorktreeConversationDoesNotGainMemberWriteAccess(t *testing.T) {
	f := newBenchDestFixture(t)

	r := f.checker.Check("Write", writeInput(filepath.Join(f.disabled, "x.go")), f.enabled)

	if r == nil || r.Kind != RefusalSiblingWorktree {
		t.Fatalf("a worktree conversation must still be refused a sibling write, got %+v", r)
	}
}
