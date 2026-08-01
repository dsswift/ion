package workspaces

import (
	"fmt"
	"path/filepath"
	"strings"
)

// RefusalKind names what the refused call targeted, so consumers and logs can
// distinguish the containment classes without parsing prose.
type RefusalKind string

const (
	// RefusalBaseRepo — a worktree conversation targeted the base repository
	// it was cut from.
	RefusalBaseRepo RefusalKind = "base_repo"
	// RefusalSiblingWorktree — a worktree conversation targeted another
	// worktree of the same repository.
	RefusalSiblingWorktree RefusalKind = "sibling_worktree"
	// RefusalBenchWrite — a file write targeted an integration bench.
	RefusalBenchWrite RefusalKind = "bench_write"
	// RefusalBenchHistory — a git history-writing command ran inside a bench.
	RefusalBenchHistory RefusalKind = "bench_history"
)

// Refusal is the typed verdict for a refused tool call. Reason is the complete
// operator/model-facing message: it names the offending path, what that path
// belongs to, and where the work belongs instead — a refusal the model can act
// on rather than merely retry.
type Refusal struct {
	Kind   RefusalKind
	Target string
	// Owners names the bench members whose pinned contributions touch the
	// refused path (bench writes only). Empty when attribution found none or
	// did not run.
	Owners []BenchOwner
	Reason string
}

// Containment describes what a directory is, resolved against the records.
type Containment struct {
	// Worktree is set when the directory is inside a registered worktree.
	Worktree *WorktreeContainment
	// Bench is set when the directory is inside an integration bench.
	Bench *BenchWorkspace
}

// WorktreeContainment is a worktree conversation's surroundings: its own
// checkout, the base repository, and every sibling worktree of the same repo.
type WorktreeContainment struct {
	WorktreePath string
	RepoPath     string
	SiblingPaths []string
}

// Checker answers "may this tool call proceed?" for workspace containment.
// Nil-safe by convention at the call site (a nil *Checker means the feature is
// disabled), mirroring how the permission engine is threaded through RunConfig.
type Checker struct {
	reg *Registry
	// git runs a git command in a directory and returns stdout. Swappable for
	// tests; defaults to the real subprocess runner in bench.go.
	git gitRunner
}

// NewChecker returns a Checker over the default registry (~/.ion records).
func NewChecker() *Checker {
	return &Checker{reg: NewRegistry(), git: runGit}
}

// NewCheckerAt returns a Checker reading records from dir. Test seam.
func NewCheckerAt(dir string) *Checker {
	return &Checker{reg: NewRegistryAt(dir), git: runGit}
}

// gatedTools is the set of tool names whose calls the checker inspects. These
// are the calls that put bytes on disk; read and dispatch tools cannot violate
// containment. Matches the permission engine's write-tool convention plus
// NotebookEdit and Bash (Bash is judged by its command text, not just cwd).
var gatedTools = map[string]bool{
	"Write":        true,
	"write":        true,
	"Edit":         true,
	"edit":         true,
	"NotebookEdit": true,
	"Bash":         true,
	"bash":         true,
}

// Resolve classifies a directory against the records. Returns a zero
// Containment (both fields nil) for a plain directory.
//
// A bench is checked FIRST: a bench is itself a git worktree of the repo, so
// worktree-style classification alone would mislabel it, and the bench rules
// (history + write refusal with owner attribution) are the correct ones there.
func (c *Checker) Resolve(dir string) Containment {
	if c == nil || dir == "" {
		return Containment{}
	}

	for i := range c.reg.Benches() {
		b := c.reg.Benches()[i]
		if isWithin(dir, b.BenchPath) {
			return Containment{Bench: &b}
		}
	}

	entries := c.reg.Worktrees()
	for _, e := range entries {
		if !isWithin(dir, e.WorktreePath) {
			continue
		}
		wc := &WorktreeContainment{WorktreePath: e.WorktreePath, RepoPath: e.RepoPath}
		for _, s := range entries {
			if s.RepoPath == e.RepoPath && s.WorktreePath != e.WorktreePath {
				wc.SiblingPaths = append(wc.SiblingPaths, s.WorktreePath)
			}
		}
		return Containment{Worktree: wc}
	}
	return Containment{}
}

// Check is the single verdict function the tool loop calls before executing a
// gated tool. Returns nil when the call may proceed, or a typed Refusal.
//
// The scope is deliberately narrow — this is NOT a cwd jail. Writes to /tmp,
// ~/.ion, an unrelated repository, or any other directory pass: agents
// legitimately need them, and over-blocking would make worktree conversations
// useless for real work. The rules are exactly:
//
//   - cwd inside a registered worktree of repo R ⇒ refuse writes into R's main
//     checkout and into R's other worktrees.
//   - cwd inside a bench, or a write TARGETING a bench from anywhere ⇒ refuse
//     file writes (the next assembly destroys them) and git history commands
//     (a bench commit is destroyed; a push publishes a synthetic merge).
//     Reads, builds, staging, and discarding pass — building and testing are
//     what a bench is for. While a resolution merge is in progress in the
//     bench (MERGE_HEAD exists), edits to its unmerged paths and
//     `git merge --continue|--abort` pass: completing that merge is how a
//     conflict is resolved once and recorded for future assemblies to replay.
func (c *Checker) Check(tool string, input map[string]interface{}, cwd string) *Refusal {
	if c == nil || !gatedTools[tool] {
		return nil
	}

	containment := c.Resolve(cwd)

	if isBash(tool) {
		cmd, ok := input["command"].(string)
		if !ok {
			// A Bash call with no command string has nothing to judge.
			return nil
		}
		return c.checkBash(cmd, cwd, containment)
	}

	target := extractTargetPath(input, cwd)
	if target == "" {
		return nil
	}
	return c.checkWriteTarget(target, containment)
}

// checkWriteTarget classifies one absolute write target against the session's
// containment plus the global bench set (a bench must refuse writes even from
// a conversation running elsewhere).
func (c *Checker) checkWriteTarget(target string, containment Containment) *Refusal {
	// Bench containment first — a bench is a worktree, so the ordering matters
	// for naming the right rule (see Resolve).
	if bench := c.benchFor(target); bench != nil {
		// Resolve-once carve-out: an edit to a path that is UNMERGED in the
		// bench's in-progress merge is the resolution itself — the artifact
		// git rerere records when the merge commits.
		if c.mergeInProgress(bench.BenchPath) && c.isUnmergedPath(bench.BenchPath, target) {
			return nil
		}
		owners := c.attributeOwners(bench, target)
		return &Refusal{
			Kind:   RefusalBenchWrite,
			Target: target,
			Owners: owners,
			Reason: benchWriteReason(target, bench, owners),
		}
	}

	wc := containment.Worktree
	if wc == nil {
		return nil
	}
	if isWithin(target, wc.WorktreePath) {
		return nil
	}
	if isWithin(target, wc.RepoPath) {
		return &Refusal{
			Kind:   RefusalBaseRepo,
			Target: target,
			Reason: worktreeReason(target, "the base repository this worktree was cut from", wc.WorktreePath),
		}
	}
	for _, sibling := range wc.SiblingPaths {
		if isWithin(target, sibling) {
			return &Refusal{
				Kind:   RefusalSiblingWorktree,
				Target: target,
				Reason: worktreeReason(target, "a different worktree belonging to another conversation", wc.WorktreePath),
			}
		}
	}
	return nil
}

// benchFor returns the bench containing path, or nil.
func (c *Checker) benchFor(path string) *BenchWorkspace {
	for i := range c.reg.Benches() {
		b := c.reg.Benches()[i]
		if isWithin(path, b.BenchPath) {
			return &b
		}
	}
	return nil
}

// isWithin reports whether path is root or a descendant of it.
//
// The separator is REQUIRED on the descendant check. A bare
// strings.HasPrefix(path, root) would also match a sibling whose name merely
// begins with the root — `…/ion-a33725460` against `…/ion-a3372546` — refusing
// writes in an unrelated directory. A false refusal in the place the operator
// is doing real work is worse than the guard not firing, so the check is
// exact-or-separator-prefixed, never bare.
func isWithin(path, root string) bool {
	if path == "" || root == "" {
		return false
	}
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(filepath.Separator))
}

func isBash(tool string) bool { return tool == "Bash" || tool == "bash" }

// extractTargetPath resolves a write tool's target to an absolute path.
// Field names cover the core write tools (file_path) and common variants.
func extractTargetPath(input map[string]interface{}, cwd string) string {
	for _, key := range []string{"file_path", "path", "filePath", "notebook_path", "targetDir"} {
		v, ok := input[key].(string)
		if !ok || v == "" {
			continue
		}
		if filepath.IsAbs(v) {
			return filepath.Clean(v)
		}
		if cwd != "" {
			return filepath.Clean(filepath.Join(cwd, v))
		}
		return ""
	}
	return ""
}

// worktreeReason builds the refusal message for a cross-worktree write. It
// names the remediation, not just the refusal — a refusal that only says "no"
// gets retried verbatim.
func worktreeReason(target, owner, worktreePath string) string {
	return fmt.Sprintf(
		"Refused: %s is inside %s. This conversation is isolated to the worktree %s; writing outside it would interleave several conversations' work in one checkout, and review could not attribute the changes afterwards. Make the change under %s instead.",
		target, owner, worktreePath, worktreePath)
}

// benchWriteReason builds the refusal message for a write into a bench,
// naming the owning member(s) so the edit can be redirected rather than
// merely retried.
func benchWriteReason(target string, bench *BenchWorkspace, owners []BenchOwner) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Refused: %s is inside the integration bench %s. A bench is reassembled from scratch on every assembly, so an edit made here is destroyed by the next assembly and never reaches anyone.", target, bench.BenchPath)
	switch len(owners) {
	case 0:
		fmt.Fprintf(&b, " No enrolled member changes this file, so it comes from the source branch %s: make the change in a worktree cut from %s and land it.", bench.SourceBranch, bench.SourceBranch)
	case 1:
		o := owners[0]
		fmt.Fprintf(&b, " This file is integrated from member %s: make the change at %s, commit it there, then update that member in the bench.", o.BranchName, o.WorktreePath)
	default:
		fmt.Fprintf(&b, " %d members change this file, so the owner depends on which lines are being edited:", len(owners))
		for _, o := range owners {
			hunks := "unknown lines"
			if len(o.Hunks) > 0 {
				hunks = strings.Join(o.Hunks, ", ")
			}
			fmt.Fprintf(&b, " %s at %s -> %s;", o.BranchName, hunks, o.WorktreePath)
		}
		b.WriteString(" edit in the member that owns those lines, commit there, then update that member in the bench.")
	}
	b.WriteString(" Reading, building, and testing in the bench are unaffected.")
	return b.String()
}
