package workspaces

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
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
	// RefusalWorktreeHistory — a Git operation would change which branch a
	// registered feature worktree holds, or remove the checkout itself.
	RefusalWorktreeHistory RefusalKind = "worktree_history"
)

// Refusal is the typed verdict for a refused tool call. Reason is the complete
// operator/model-facing message: it names the offending path, what that path
// belongs to, and where the work belongs instead — a refusal the model can act
// on rather than merely retry.
type Refusal struct {
	Kind   RefusalKind
	Target string
	Reason string
}

// Containment describes what a directory is, resolved against the record.
type Containment struct {
	// Worktree is set when the directory is inside a registered worktree.
	Worktree *WorktreeContainment
}

// WorktreeContainment is a worktree conversation's surroundings: its own
// checkout, the base repository, and every sibling worktree of the same repo.
type WorktreeContainment struct {
	WorktreePath string
	RepoPath     string
	BranchName   string
	SiblingPaths []string
}

// Checker answers "may this tool call proceed?" for workspace containment, and
// owns the read-only context queries over the same record.
// Nil-safe by convention at the call site (a nil *Checker means the feature is
// disabled), mirroring how the permission engine is threaded through RunConfig.
type Checker struct {
	reg *Registry
	// git runs a git command in a directory and returns stdout. Swappable for
	// tests; defaults to the real subprocess runner in git.go. Deliberately
	// NOT context-aware: it runs on the refusal path, where a cancellable guard
	// is not a guard.
	git gitRunner
	// gitCtx runs a context-aware git command in a directory and returns
	// stdout. Swappable for tests; defaults to runGitCtx (worktree_query.go).
	// Used by the cross-worktree query tools (WorktreeList, WorktreeCommits,
	// WorktreeDiff), which are potentially longer-running informational reads
	// that should die with an aborted turn -- unlike the refusal path above,
	// cancellation is exactly the right behavior here.
	gitCtx ctxGitRunner
	// canonical memoizes symlink resolution for the record's ROOTS, which are
	// re-read on every gated call but only change when the record changes.
	canonical canonicalCache
}

// NewChecker returns a Checker over the default registry (~/.ion records).
func NewChecker() *Checker {
	return &Checker{reg: NewRegistry(), git: runGit, gitCtx: runGitCtx}
}

// NewCheckerAt returns a Checker reading records from dir. Test seam.
func NewCheckerAt(dir string) *Checker {
	return &Checker{reg: NewRegistryAt(dir), git: runGit, gitCtx: runGitCtx}
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

// Resolve classifies a directory against the record. Returns a zero
// Containment (Worktree nil) for a plain directory.
//
// Both sides are canonicalized before comparison. On macOS this is not an edge
// case: /tmp and /var are symlinks to /private/..., so a recorded path and a
// resolved cwd routinely differ by spelling for the same directory — and a raw
// string comparison would classify a worktree as a plain directory and pass
// every write it exists to refuse.
func (c *Checker) Resolve(dir string) Containment {
	if c == nil || dir == "" {
		return Containment{}
	}
	canonicalDir := c.canonical.get(dir)

	entries := c.reg.Worktrees()
	for _, e := range entries {
		if !c.within(canonicalDir, e.WorktreePath) {
			continue
		}
		wc := &WorktreeContainment{
			WorktreePath: e.WorktreePath,
			RepoPath:     e.RepoPath,
			BranchName:   e.BranchName,
		}
		for _, s := range entries {
			if s.RepoPath == e.RepoPath && s.WorktreePath != e.WorktreePath {
				wc.SiblingPaths = append(wc.SiblingPaths, s.WorktreePath)
			}
		}
		return Containment{Worktree: wc}
	}
	return Containment{}
}

// within compares an already-canonical path against a record root, canonicalizing
// the root through the cache. Both sides canonical is the invariant every
// containment comparison in this package depends on.
func (c *Checker) within(canonicalPath, root string) bool {
	if canonicalPath == "" || root == "" {
		return false
	}
	// Compare against the raw root too: a root that cannot be resolved (a
	// worktree whose directory was removed) still has to enforce, and its
	// canonical form falls back to the lexical one anyway.
	return isWithin(canonicalPath, c.canonical.get(root)) || isWithin(canonicalPath, filepath.Clean(root))
}

// Check is the single verdict function the tool loop calls before executing a
// gated tool. Returns nil when the call may proceed, or a typed Refusal.
//
// The scope is deliberately narrow — this is NOT a cwd jail. Writes to /tmp,
// ~/.ion, an unrelated repository, or any other directory pass: agents
// legitimately need them, and over-blocking would make worktree conversations
// useless for real work. The rule is exactly:
//
//   - cwd inside a registered worktree of repo R ⇒ refuse writes into R's main
//     checkout and into R's other worktrees.
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
// containment.
func (c *Checker) checkWriteTarget(target string, containment Containment) *Refusal {
	canonicalTarget := canonicalizePath(target)

	wc := containment.Worktree
	if wc == nil {
		return nil
	}
	if c.within(canonicalTarget, wc.WorktreePath) {
		return nil
	}
	if c.within(canonicalTarget, wc.RepoPath) {
		return &Refusal{
			Kind:   RefusalBaseRepo,
			Target: canonicalTarget,
			Reason: worktreeReason(canonicalTarget, "the base repository this worktree was cut from", wc.WorktreePath),
		}
	}
	for _, sibling := range wc.SiblingPaths {
		if c.within(canonicalTarget, sibling) {
			return &Refusal{
				Kind:   RefusalSiblingWorktree,
				Target: canonicalTarget,
				Reason: worktreeReason(canonicalTarget, "a different worktree belonging to another conversation", wc.WorktreePath),
			}
		}
	}
	return nil
}

// checkBash judges a Bash command against worktree containment. A single
// command can `cd` out of the worktree and commit elsewhere, so every literal
// destination the command can be PROVEN to operate in is checked — the cwd
// plus every literal `cd`/`pushd`/`git -C`/`--work-tree` target (bash.go). A
// dynamic destination (`cd "$VAR"`, `cd $(...)`) cannot be resolved: it passes
// and is logged at WARN, because refusing on unresolved destinations would
// refuse legitimate work in the conversation's own worktree, and `eval`
// defeats any command-string parser anyway. Closing that gap needs
// process-level containment, a different mechanism.
func (c *Checker) checkBash(command, cwd string, containment Containment) *Refusal {
	if command == "" {
		return nil
	}

	dest := resolveBashDestinations(command, cwd)
	if dest.UnresolvedHint != "" {
		utils.LogWithFields(utils.LevelWarn, logTag, "bash destination unresolved, passing", map[string]any{
			"hint": dest.UnresolvedHint, "cwd": cwd,
		})
	}

	// Every proven destination is judged as if the command ran there: worktree
	// containment for writes implied by `cd <dir> && git commit`, and the
	// worktree identity rule for git invocations.
	for _, seg := range dest.Segments {
		if r := c.checkBashSegment(seg, containment, cwd); r != nil {
			return r
		}
	}
	return nil
}

// checkBashSegment judges one shell segment operating in one proven directory.
func (c *Checker) checkBashSegment(seg bashSegment, containment Containment, cwd string) *Refusal {
	// Every literal destination is canonicalized before comparison, for the same
	// reason write targets are: a `cd /tmp/...` on macOS resolves under
	// /private, and an uncanonicalized comparison would classify the same
	// directory two different ways depending on which side of the check it came
	// from.
	segDir := ""
	if seg.Dir != "" {
		segDir = canonicalizePath(seg.Dir)
	}

	wc := containment.Worktree
	if wc == nil {
		return nil
	}

	// Worktree containment: a segment whose working directory is the base repo
	// or a sibling is the exact way a command escapes isolation.
	if segDir != "" && !c.within(segDir, wc.WorktreePath) {
		if c.within(segDir, wc.RepoPath) {
			return &Refusal{
				Kind:   RefusalBaseRepo,
				Target: segDir,
				Reason: worktreeReason(segDir, "the base repository this worktree was cut from", wc.WorktreePath),
			}
		}
		for _, sibling := range wc.SiblingPaths {
			if c.within(segDir, sibling) {
				return &Refusal{
					Kind:   RefusalSiblingWorktree,
					Target: segDir,
					Reason: worktreeReason(segDir, "a different worktree belonging to another conversation", wc.WorktreePath),
				}
			}
		}
	}

	// The directory the git invocation runs in: the segment dir when proven,
	// else the session cwd.
	gitDir := segDir
	if gitDir == "" {
		gitDir = canonicalizePath(cwd)
	}

	// A registered feature worktree holds one conversation's branch. Refuse
	// only operations that change WHICH branch it holds, or whether the
	// checkout exists — never the history verbs (`rebase`, `reset`, `stash`,
	// `commit --amend`, `push`, `branch -f`) that the operator's own /align,
	// /squash, and /create-pr workflows are built from. A detached HEAD left
	// behind by one of those is caught after execution by InspectAttachment.
	//
	// `c.within`, never bare isWithin: both sides must be canonical. On macOS a
	// resolved temp path (/private/var/...) and a recorded root (/var/...) name
	// the same directory and compare unequal lexically, so a bare prefix test
	// silently never matched and the guard did not fire at all.
	if c.within(gitDir, wc.WorktreePath) {
		for _, op := range seg.GitOperations {
			if verb, changes := op.WorktreeIdentityChange(); changes {
				return &Refusal{
					Kind:   RefusalWorktreeHistory,
					Target: gitDir,
					Reason: worktreeHistoryReason(verb, wc),
				}
			}
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

// worktreeHistoryReason builds the refusal for an operation that would change
// which branch a worktree holds, or remove it. It names the verb refused and
// the branch that must stay checked out, and it states what is still allowed —
// a refusal that reads as "no git here" gets worked around, and the amend and
// squash workflows genuinely need those verbs.
func worktreeHistoryReason(verb string, worktree *WorktreeContainment) string {
	branch := worktree.BranchName
	if branch == "" {
		branch = "its assigned branch"
	}
	return fmt.Sprintf(
		"Refused: `git %s` would change which branch the worktree %s holds, or remove the checkout this conversation is running in. It must stay on %s. Committing, amending, rebasing, resetting, stashing, cherry-picking, branch management, and pushing are all still allowed here — only moving or removing the checkout itself is not. To work on a different branch, use a worktree cut for it.",
		verb, worktree.WorktreePath, branch)
}
