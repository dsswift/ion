package workspaces

// Cross-worktree read-only queries: "what other worktrees exist for this
// repo, what have they committed, what does their diff look like."
//
// ── Why this exists ─────────────────────────────────────────────────────────
// A worktree conversation has no reliable way to discover its siblings today.
// `Read`/`Grep`/`Glob` are never gated cross-worktree (see gatedTools in
// containment.go — only Write/Edit/NotebookEdit/Bash are), and a plain
// `git log <branch>` run from the CALLING worktree's own cwd already
// succeeds without any `cd`, because every `git worktree add` checkout of the
// same repo shares one object database and one refs namespace. But nothing
// tells the model this is possible or does it cleanly, so it defaults to the
// wrong pessimistic assumption ("I cannot see another worktree's work at
// all") instead of a purpose-built query. This closes that gap the same way
// the bench tools (WorkspaceAttribution, BenchMemberFile,
// BenchResolutionHistory) closed it for benches — except this is generic
// worktree mechanism, not Ion's bench product, so per ADR-025's ownership
// split it belongs in engine core, registered globally like Read/Grep/Glob.
//
// ── The safety property, stronger than any existing tool ────────────────────
// Every git invocation here runs with cwd = the CALLING conversation's own
// directory, never a sibling worktree's path. Cross-worktree data is read
// entirely through the shared git object store by referencing another
// worktree's branch name (`git log <branch>`, `git diff A...B`, `git show
// <sha>`) — this package never opens, lists, or sets its working directory to
// a sibling's checkout. Only a fixed set of read-only git subcommands is ever
// invoked (log, diff, show, rev-list, rev-parse) — never a model-supplied
// command string — so these tools are mechanically incapable of writing
// anywhere, let alone outside the caller's own worktree.
//
// ── Why git calls here are context-aware, unlike the refusal path ───────────
// containment.go's gitRunner is deliberately NOT context-aware: it runs on
// the refusal path, where "a cancellable guard is not a guard" (a check that
// could be cancelled mid-flight could be made to silently pass). That
// reasoning does not apply here — these are potentially longer-running
// informational reads (a big `git log`, a big `git diff`) that SHOULD die
// with an aborted turn, so they use the context-aware runner below.
import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ctxGitRunner runs a context-aware git command in a directory and returns
// stdout. Swappable for tests; defaults to runGitCtx.
type ctxGitRunner func(ctx context.Context, dir string, args ...string) (string, error)

// gitQueryWaitDelay bounds cancellation cleanup when a git descendant keeps
// stdout/stderr pipes open after CommandContext kills git itself.
const gitQueryWaitDelay = time.Second

// runGitCtx executes a read-only git query in dir, honoring ctx cancellation.
//
// Every call is prefixed with --no-optional-locks, matching gitcontext.go's
// runGit: without it, git opportunistically refreshes the on-disk index for
// some read commands, taking .git/index.lock and colliding with whatever git
// command the operator is running concurrently in the same worktree.
func runGitCtx(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-optional-locks"}, args...)...)
	cmd.WaitDelay = gitQueryWaitDelay
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// worktreeGroup resolves "every registered worktree sharing cwd's repo",
// plus which entry (if any) IS cwd. Three cases:
//
//   - cwd is inside a registered worktree: group by that entry's RepoPath.
//   - cwd is not itself a worktree, but IS some entry's RepoPath (i.e. the
//     conversation runs in the base checkout): group by that RepoPath too,
//     so the base checkout can enumerate its own worktrees. self is nil in
//     this case — the base checkout is not itself a worktree entry.
//   - cwd matches neither: empty group, repoPath "".
//
// Both sides of every comparison go through the canonical cache: macOS
// symlinks /tmp -> /private/tmp, so a raw string comparison would silently
// misclassify the exact directories this package exists to reason about.
func (c *Checker) worktreeGroup(cwd string) (repoPath string, entries []WorktreeEntry, self *WorktreeEntry) {
	if c == nil || cwd == "" {
		return "", nil, nil
	}
	canonicalCwd := c.canonical.get(cwd)
	all := c.reg.Worktrees()

	// Case 1: cwd is inside a registered worktree.
	for i := range all {
		e := all[i]
		if c.within(canonicalCwd, e.WorktreePath) {
			repoPath = e.RepoPath
			self = &all[i]
			break
		}
	}
	// Case 2: cwd is a registered worktree's RepoPath (the base checkout).
	if repoPath == "" {
		for _, e := range all {
			if c.within(canonicalCwd, e.RepoPath) {
				repoPath = e.RepoPath
				break
			}
		}
	}
	if repoPath == "" {
		return "", nil, nil
	}
	for _, e := range all {
		if e.RepoPath == repoPath {
			entries = append(entries, e)
		}
	}
	return repoPath, entries, self
}

// resolveWorktreeTarget resolves a "worktree" parameter (branch name or
// worktree path) against the group for cwd. An empty want resolves to self
// (the caller's own entry) when available. Returns a rejection message,
// never an error, so a caller gets an actionable answer instead of a stack
// trace.
func (c *Checker) resolveWorktreeTarget(cwd, want string) (entry *WorktreeEntry, group []WorktreeEntry, rejection string) {
	repoPath, entries, self := c.worktreeGroup(cwd)
	if repoPath == "" {
		return nil, nil, cwd + " is not inside a registered worktree or a repository with registered worktrees, so there is no worktree group to query"
	}
	if want == "" {
		if self == nil {
			return nil, entries, "no worktree was named, and " + cwd + " is the base checkout, not a worktree itself; name one via the worktree parameter (see the group in this result)"
		}
		return self, entries, ""
	}
	wantCanonical := c.canonical.get(want)
	for i := range entries {
		e := entries[i]
		if e.BranchName == want || e.WorktreePath == want || c.canonical.get(e.WorktreePath) == wantCanonical {
			return &entries[i], entries, ""
		}
	}
	return nil, entries, "no worktree of this repository matches " + want + "; see the group in this result for the registered set"
}

// headSummary returns the HEAD commit's full sha and subject for branch, run
// in runDir (always the CALLING conversation's own directory — see the
// package doc). Empty values on any failure; the caller states the gap as a
// warning rather than failing the whole request over one enrichment.
func (c *Checker) headSummary(ctx context.Context, runDir, branch string) (sha, subject string) {
	if branch == "" {
		return "", ""
	}
	out, err := c.gitCtx(ctx, runDir, "log", "-1", "--format=%H%x1f%s", branch)
	if err != nil {
		utils.LogWithFields(utils.LevelDebug, logTag, "head summary enrichment failed", map[string]any{
			"run_dir": runDir, "branch": branch, "error": err.Error(),
		})
		return "", ""
	}
	parts := splitUnitSep(out)
	if len(parts) < 2 {
		return "", ""
	}
	return parts[0], parts[1]
}

// unlandedCount returns the number of commits on branch not reachable from
// sourceBranch, run in runDir. -1 (with ok=false) when sourceBranch is empty
// or the rev-list fails (an unresolvable source branch, most often).
func (c *Checker) unlandedCount(ctx context.Context, runDir, sourceBranch, branch string) (count int, ok bool) {
	if sourceBranch == "" || branch == "" {
		return -1, false
	}
	out, err := c.gitCtx(ctx, runDir, "rev-list", "--count", sourceBranch+".."+branch)
	if err != nil {
		utils.LogWithFields(utils.LevelDebug, logTag, "unlanded count enrichment failed", map[string]any{
			"run_dir": runDir, "source_branch": sourceBranch, "branch": branch, "error": err.Error(),
		})
		return -1, false
	}
	n, parseErr := strconv.Atoi(trimNewline(out))
	if parseErr != nil {
		utils.LogWithFields(utils.LevelDebug, logTag, "unlanded count parse failed", map[string]any{
			"run_dir": runDir, "source_branch": sourceBranch, "branch": branch, "raw": trimNewline(out),
		})
		return -1, false
	}
	return n, true
}

func splitUnitSep(s string) []string {
	return splitOn(trimNewline(s), '\x1f')
}

func splitOn(s string, sep byte) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

// existsOnDisk reports whether path is a directory that exists. Best-effort:
// a stat failure (permission, removed checkout) simply reads as false —
// exactly the fact the caller wants to report ("this entry is registered but
// gone"), not an error to propagate.
func existsOnDisk(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
