package workspaces

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// gitRunner runs a git command in a directory and returns stdout. The error
// carries a non-zero exit. Swappable for tests.
type gitRunner func(dir string, args ...string) (string, error)

func runGit(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	return string(out), err
}

// historyWritingSubcommands are the git verbs refused inside a bench. Each
// either creates a commit the next assembly destroys, publishes a synthetic
// merge, moves the bench branch out from under the assembly's `switch -C`, or
// anchors a synthetic commit behind a ref that outlives the assembly. `pull`
// is fetch-plus-merge: it writes history exactly like `merge`. `tag` both
// survives the assembly that destroys its target and is pushable.
//
// Deliberately ABSENT: add, rm, restore, clean, apply — index and working-tree
// verbs that `--discard-changes` already resets, and blocking them would stop
// the operator inspecting or tidying a bench tree (`apply` is how hunk-level
// staging works). Also absent: every read verb. Over-blocking is as much a
// defect as under-blocking: the bench's only purpose is to build and test.
var historyWritingSubcommands = map[string]bool{
	"commit": true, "push": true, "pull": true, "merge": true,
	"rebase": true, "cherry-pick": true, "revert": true, "reset": true,
	"branch": true, "checkout": true, "switch": true, "stash": true,
	"tag": true, "am": true, "filter-branch": true,
}

// checkBash judges a Bash command against both containment classes. A single
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
	// containment for writes implied by `cd <dir> && git commit`, and bench
	// history rules for git invocations.
	for _, seg := range dest.Segments {
		if r := c.checkBashSegment(seg, containment, cwd); r != nil {
			return r
		}
	}
	return nil
}

// checkBashSegment judges one shell segment operating in one proven directory.
func (c *Checker) checkBashSegment(seg bashSegment, containment Containment, cwd string) *Refusal {
	// Worktree containment: a segment whose working directory is the base repo
	// or a sibling is the exact way a command escapes isolation.
	if wc := containment.Worktree; wc != nil && seg.Dir != "" {
		if !isWithin(seg.Dir, wc.WorktreePath) {
			if isWithin(seg.Dir, wc.RepoPath) {
				return &Refusal{
					Kind:   RefusalBaseRepo,
					Target: seg.Dir,
					Reason: worktreeReason(seg.Dir, "the base repository this worktree was cut from", wc.WorktreePath),
				}
			}
			for _, sibling := range wc.SiblingPaths {
				if isWithin(seg.Dir, sibling) {
					return &Refusal{
						Kind:   RefusalSiblingWorktree,
						Target: seg.Dir,
						Reason: worktreeReason(seg.Dir, "a different worktree belonging to another conversation", wc.WorktreePath),
					}
				}
			}
		}
	}

	// Bench history rules: judged for the directory the git invocation runs
	// in, which is the segment dir when proven, else the session cwd.
	gitDir := seg.Dir
	if gitDir == "" {
		gitDir = cwd
	}
	bench := c.benchFor(gitDir)
	if bench == nil {
		return nil
	}
	for _, sub := range seg.GitSubcommands {
		if !historyWritingSubcommands[sub] {
			continue
		}
		// Resolve-once carve-out: while a merge is in progress in the bench,
		// `git merge --continue|--abort` DRIVES that merge rather than
		// creating one — completing it records the conflict resolution every
		// later assembly replays. Scoped to the driver verbs only: a fresh
		// `git merge <ref>` or any other history verb stays refused mid-merge.
		if sub == "merge" && seg.MergeDriverOnly && c.mergeInProgress(bench.BenchPath) {
			continue
		}
		return &Refusal{
			Kind:   RefusalBenchHistory,
			Target: gitDir,
			Reason: benchHistoryReason(sub, bench),
		}
	}
	return nil
}

// mergeInProgress reports whether a merge is open in the bench (MERGE_HEAD
// exists). `--git-path` because a bench is a linked worktree whose state lives
// under the common dir; a hardcoded `.git/MERGE_HEAD` join would miss it.
// Fails CLOSED for the carve-outs that call it: an unreadable probe reports
// "no merge", so the check refuses exactly as it would without the carve-out —
// the conservative direction for a permission widening.
func (c *Checker) mergeInProgress(benchPath string) bool {
	out, err := c.git(benchPath, "rev-parse", "--git-path", "MERGE_HEAD")
	if err != nil {
		return false
	}
	p := strings.TrimSpace(out)
	if p == "" {
		return false
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(benchPath, p)
	}
	_, statErr := os.Stat(p)
	return statErr == nil
}

// isUnmergedPath reports whether target is one of the bench merge's unmerged
// paths. Only meaningful while mergeInProgress; fails closed.
func (c *Checker) isUnmergedPath(benchPath, target string) bool {
	out, err := c.git(benchPath, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(benchPath, target)
	if err != nil || strings.HasPrefix(rel, "..") {
		return false
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == rel {
			return true
		}
	}
	return false
}

// BenchOwner is one bench member whose pinned contribution touches a refused
// path, with the changed line ranges that make a multi-owner answer usable.
type BenchOwner struct {
	WorktreePath string
	BranchName   string
	// Hunks are changed line ranges in the file, as "L<start>-<end>" strings.
	Hunks []string
}

var hunkHeaderRe = regexp.MustCompile(`^@@ .* \+(\d+)(?:,(\d+))? @@`)

// attributeOwners finds every enabled member whose pinned CONTRIBUTION RANGE
// touches target. The range (`pinnedBaseSha..pinnedSha`) is the question the
// assembly's merge actually asks; a member's tip commit alone misses any
// collision introduced by an earlier commit in the range, and "who last
// touched this file" is confidently wrong whenever several members change one
// file. Best-effort: a member whose diff cannot be read is omitted, and the
// refusal still fires — attribution improves the message, it never turns a
// refusal into a pass.
func (c *Checker) attributeOwners(bench *BenchWorkspace, target string) []BenchOwner {
	rel, err := filepath.Rel(bench.BenchPath, target)
	if err != nil || strings.HasPrefix(rel, "..") {
		return nil
	}

	var owners []BenchOwner
	for _, m := range bench.Members {
		if !m.EnabledOrDefault() || m.PinnedSha == "" {
			continue
		}
		base := m.PinnedBase
		if base == "" {
			base = bench.BaseSha
		}
		if base == "" {
			continue
		}
		changed, err := c.git(bench.BenchPath, "diff", "--name-only", base, m.PinnedSha, "--", rel)
		if err != nil || strings.TrimSpace(changed) == "" {
			continue
		}
		owners = append(owners, BenchOwner{
			WorktreePath: m.WorktreePath,
			BranchName:   m.BranchName,
			Hunks:        c.readHunks(bench.BenchPath, base, m.PinnedSha, rel),
		})
	}
	return owners
}

// readHunks returns changed line ranges for one member's contribution to one
// file. `-U0` gives one hunk header per contiguous change. Capped: enough to
// orient the redirect, not a full diff dump. Best-effort colour on an
// already-correct refusal.
func (c *Checker) readHunks(benchPath, base, sha, rel string) []string {
	out, err := c.git(benchPath, "diff", "-U0", base, sha, "--", rel)
	if err != nil {
		return nil
	}
	var ranges []string
	for _, line := range strings.Split(out, "\n") {
		m := hunkHeaderRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		start := m[1]
		if m[2] == "" || m[2] == "1" {
			ranges = append(ranges, "L"+start)
		} else {
			var s, n int
			fmt.Sscanf(start, "%d", &s)         //nolint:errcheck // regexp guarantees digits
			fmt.Sscanf(m[2], "%d", &n)          //nolint:errcheck // regexp guarantees digits
			ranges = append(ranges, fmt.Sprintf("L%d-%d", s, s+n-1))
		}
		if len(ranges) >= 6 {
			break
		}
	}
	return ranges
}

// benchHistoryReason builds the refusal for a history verb inside a bench.
func benchHistoryReason(subcommand string, bench *BenchWorkspace) string {
	return fmt.Sprintf(
		"Refused: `git %s` inside the integration bench %s. A bench branch is recreated from scratch on every assembly, so a commit made here is destroyed by the next assembly and a push would publish a synthetic merge of other people's in-flight work. Commit in the member worktree that owns the change, then update that member in the bench. Reading, building, testing, and staging are unaffected.",
		subcommand, bench.BenchPath)
}
