package workspaces

// Post-execution attachment inspection for registered feature worktrees.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// A worktree conversation is pinned to one branch. The failure this catches is
// an END STATE, not a command: a `git rebase` hit a conflict, stopped halfway,
// and left HEAD detached at the rebase's transient position. Nothing in the
// engine noticed. The agent kept working, and the operator only found out
// because the desktop's Worktrees panel showed the checkout as missing.
//
// The first attempt at a fix banned every verb that could produce that state
// (rebase, reset, stash, cherry-pick, amend, push, branch -f). That is the
// "heuristic instead of a precise mechanism" anti-pattern: those verbs are
// exactly what the operator's /align, /squash, and /create-pr workflows are
// built from, so the guard broke the workflows it was meant to protect while
// still not actually checking the invariant.
//
// So the invariant is checked directly, where it is unambiguous: AFTER a Bash
// call that could have moved HEAD, ask git what state the worktree is in. A
// detached HEAD or an interrupted operation is reported back to the model in
// the tool result, at the moment it happens, while the context to fix it is
// still live. Mid-flight is not itself an error — a conflicted rebase is a
// normal step of /align's amend sequence — so the report names the branch to
// return to and the commands that finish or unwind the operation.
//
// This inspects and reports. It never runs a recovery command: re-attaching
// HEAD on the model's behalf could discard a half-finished rebase the operator
// wants to resolve by hand.

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Attachment is the post-execution state of a registered worktree's HEAD.
type Attachment struct {
	// Detached is true when HEAD does not point at a branch.
	Detached bool
	// Operation names an interrupted git operation ("rebase", "merge",
	// "cherry-pick", "revert", "bisect"), or is empty when none is in flight.
	Operation string
	// RecordedBranch is the branch git recorded for an in-progress rebase
	// (rebase-merge/head-name). This is what makes a mid-rebase worktree
	// identifiable while HEAD is detached; empty when unavailable.
	RecordedBranch string
	// ExpectedBranch is the branch the registry says this worktree holds.
	ExpectedBranch string
	// WorktreePath is the registered checkout that was inspected.
	WorktreePath string
}

// NeedsAttention reports whether the worktree is in a state the model must be
// told about: HEAD off its branch, or an operation left mid-flight.
func (a Attachment) NeedsAttention() bool {
	return a.Detached || a.Operation != ""
}

// gitStateProbes maps an on-disk marker under the worktree's git dir to the
// operation it indicates. Ordered most-specific first: a rebase in progress
// also leaves a REBASE_HEAD, so the directory forms are checked before it.
var gitStateProbes = []struct {
	path      string
	operation string
}{
	{"rebase-merge", "rebase"},
	{"rebase-apply", "rebase"},
	{"MERGE_HEAD", "merge"},
	{"CHERRY_PICK_HEAD", "cherry-pick"},
	{"REVERT_HEAD", "revert"},
	{"BISECT_LOG", "bisect"},
}

// InspectAttachment reports the HEAD state of the registered worktree
// containing dir. Returns nil when dir is not in a registered worktree, or
// when the worktree is healthy — an attached HEAD with no operation running.
//
// Fails OPEN in the same way as the rest of this package: an unreadable git
// state yields no report rather than a false alarm, and logs.
func (c *Checker) InspectAttachment(dir string) *Attachment {
	if c == nil || dir == "" {
		return nil
	}
	containment := c.Resolve(dir)
	wc := containment.Worktree
	if wc == nil {
		return nil
	}

	head, err := c.git(wc.WorktreePath, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "cannot read worktree HEAD, skipping attachment check", map[string]any{
			"worktree_path": wc.WorktreePath, "error": err.Error(),
		})
		return nil
	}

	att := Attachment{
		// `rev-parse --abbrev-ref HEAD` prints the literal "HEAD" when
		// detached — the same string the desktop's inventory keys on.
		Detached:       strings.TrimSpace(head) == "HEAD",
		ExpectedBranch: wc.BranchName,
		WorktreePath:   wc.WorktreePath,
	}
	att.Operation, att.RecordedBranch = c.probeOperation(wc.WorktreePath)

	if !att.NeedsAttention() {
		return nil
	}
	utils.LogWithFields(utils.LevelWarn, logTag, "worktree left off its assigned branch", map[string]any{
		"worktree_path":   att.WorktreePath,
		"detached":        att.Detached,
		"operation":       att.Operation,
		"recorded_branch": att.RecordedBranch,
		"expected_branch": att.ExpectedBranch,
	})
	return &att
}

// probeOperation returns the in-progress git operation and, for a rebase, the
// branch git recorded in rebase-merge/head-name.
//
// Resolved through `git rev-parse --git-path`, never a hardcoded `.git/` join:
// a worktree is a LINKED checkout whose state lives under the common dir at
// `.git/worktrees/<id>/`, so a naive join misses every marker and the probe
// silently reports "clean" for a worktree that is mid-rebase.
func (c *Checker) probeOperation(worktreePath string) (operation, recordedBranch string) {
	for _, probe := range gitStateProbes {
		resolved, err := c.git(worktreePath, "rev-parse", "--git-path", probe.path)
		if err != nil {
			continue
		}
		p := strings.TrimSpace(resolved)
		if p == "" {
			continue
		}
		if !filepath.IsAbs(p) {
			p = filepath.Join(worktreePath, p)
		}
		if _, statErr := os.Stat(p); statErr != nil {
			continue
		}
		if probe.operation == "rebase" {
			return probe.operation, readRebaseHeadName(p)
		}
		return probe.operation, ""
	}
	return "", ""
}

// readRebaseHeadName reads the branch a rebase is replaying onto from
// <rebase-dir>/head-name, which holds a full ref ("refs/heads/wt/foo").
// Best-effort: an unreadable file just means the branch is unnamed in the
// report, never that the operation goes unreported.
func readRebaseHeadName(rebaseDir string) string {
	raw, err := os.ReadFile(filepath.Join(rebaseDir, "head-name"))
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(strings.TrimSpace(string(raw)), "refs/heads/")
}

// Notice renders the operator/model-facing warning appended to a tool result.
//
// It states the state, names the branch to end on, and gives the commands that
// resolve it. It never says "do not run X" — the operation is usually a
// legitimate step of an amend or squash sequence, and the requirement is only
// that the worktree does not stay this way.
func (a Attachment) Notice() string {
	branch := a.ExpectedBranch
	if branch == "" {
		branch = a.RecordedBranch
	}

	var b strings.Builder
	b.WriteString("\n\n[worktree attachment] ")

	switch {
	case a.Operation != "" && a.Detached:
		b.WriteString("This command left the worktree " + a.WorktreePath +
			" with a detached HEAD and an interrupted `" + a.Operation + "`.")
	case a.Operation != "":
		b.WriteString("An interrupted `" + a.Operation + "` is in progress in the worktree " +
			a.WorktreePath + ".")
	default:
		b.WriteString("This command left HEAD detached in the worktree " + a.WorktreePath + ".")
	}

	if branch != "" {
		b.WriteString(" This conversation's branch is " + branch + ".")
	}

	switch a.Operation {
	case "":
		b.WriteString(" Re-attach before continuing")
		if branch != "" {
			b.WriteString(" (`git checkout " + branch + "`, or `git checkout -B " + branch +
				" HEAD` to keep the commits made while detached)")
		}
		b.WriteString(".")
	case "bisect":
		b.WriteString(" Finish with `git bisect reset`, which restores the original branch.")
	default:
		b.WriteString(" Finishing the operation (`git " + a.Operation +
			" --continue`) or unwinding it (`git " + a.Operation +
			" --abort`) re-attaches HEAD. Mid-operation is fine while you are resolving it" +
			" — leaving the worktree this way at the end of the turn is not.")
	}

	b.WriteString(" Do not leave the worktree detached: the desktop reports it as missing," +
		" and a later sync reads the wrong commit.")
	return b.String()
}
