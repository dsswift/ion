// Workspace prompt context: the exact registry facts about the directory a
// conversation is running in, as a structured value plus a generic formatter.
//
// ── Why structured first, prose second ──────────────────────────────────────
// The engine owns the MECHANISM — reading the record and stating what it
// says. It does not own the OPINION of how those facts should be phrased to a
// model, which is a harness concern that varies per consumer. So the model is
// the contract and the formatter is one least-opinionated default over it: a
// consumer that wants different prose reads the same struct and writes its own,
// with no need to re-derive anything from git or re-parse the record.
//
// ── Why the prose is deliberately thin ──────────────────────────────────────
// The formatter states facts and the safety invariant the engine actually
// enforces (a worktree conversation writes only inside its own worktree). It
// does NOT prescribe a workflow — which conversation should fix what, how to
// review. Those are the harness's opinions, and hardcoding them here would
// force every consumer through one product's workflow. The line is: the engine
// explains what is true and what is refused; the harness decides what to do
// about it.
package workspaces

import (
	"fmt"
	"strings"
)

// ContextKind names what the conversation's directory is.
type ContextKind string

const (
	// ContextNone — a plain directory: not a worktree.
	ContextNone ContextKind = ""
	// ContextWorktree — inside a registered worktree.
	ContextWorktree ContextKind = "worktree"
)

// PromptContext is the complete structured description of a conversation's
// workspace surroundings. Worktree is set exactly when Kind is
// ContextWorktree; it is nil for ContextNone.
type PromptContext struct {
	Kind     ContextKind      `json:"kind"`
	Cwd      string           `json:"cwd"`
	Worktree *WorktreeContext `json:"worktree,omitempty"`
	// Bench carries the structured bench descriptor when Kind is "bench".
	// Named separately so SDK hooks receive it as WorkspacePromptContext.bench
	// rather than losing it in the generic client bag.
	Bench map[string]any `json:"bench,omitempty"`
	// Client carries opaque structured data supplied by the client for
	// non-worktree workspace kinds (bench, remote, custom). The engine
	// does not interpret it; extensions receive it as-is via the SDK's
	// WorkspacePromptContext.client field.
	Client map[string]any `json:"client,omitempty"`
}

// Empty reports whether there is nothing to say about this directory.
func (p PromptContext) Empty() bool { return p.Kind == ContextNone }

// WorktreeContext describes an isolated worktree conversation: its own
// checkout, the base repo it may not write into, and its siblings.
type WorktreeContext struct {
	WorktreePath string `json:"worktreePath"`
	RepoPath     string `json:"repoPath"`
	BranchName   string `json:"branchName,omitempty"`
	SourceBranch string `json:"sourceBranch,omitempty"`
	Title        string `json:"title,omitempty"`
	// Landed is true when this worktree's work already reached its source
	// branch.
	Landed bool `json:"landed,omitempty"`
	// Siblings are the other worktrees of the same repository, which this
	// conversation may not write into.
	Siblings []SiblingContext `json:"siblings,omitempty"`
}

// SiblingContext is one other worktree of the same repository.
type SiblingContext struct {
	WorktreePath string `json:"worktreePath"`
	BranchName   string `json:"branchName,omitempty"`
	Title        string `json:"title,omitempty"`
}

// PromptContextFor builds the structured workspace context for a directory.
// Returns a zero PromptContext (Empty) for a plain directory, a nil Checker, or
// an empty cwd — the caller injects nothing in that case.
func (c *Checker) PromptContextFor(cwd string) PromptContext {
	if c == nil || cwd == "" {
		return PromptContext{}
	}
	containment := c.Resolve(cwd)
	if containment.Worktree != nil {
		return PromptContext{Kind: ContextWorktree, Cwd: cwd, Worktree: c.worktreeContext(containment.Worktree)}
	}
	return PromptContext{}
}

// worktreeContext enriches worktree containment with the registry's
// descriptive fields.
func (c *Checker) worktreeContext(wc *WorktreeContainment) *WorktreeContext {
	out := &WorktreeContext{WorktreePath: wc.WorktreePath, RepoPath: wc.RepoPath}

	entries := c.reg.Worktrees()
	byPath := make(map[string]WorktreeEntry, len(entries))
	for _, e := range entries {
		byPath[e.WorktreePath] = e
	}
	if self, ok := byPath[wc.WorktreePath]; ok {
		out.BranchName = self.BranchName
		out.SourceBranch = self.SourceBranch
		out.Title = self.Title
		out.Landed = self.Landed()
	}
	for _, sibling := range wc.SiblingPaths {
		s := SiblingContext{WorktreePath: sibling}
		if e, ok := byPath[sibling]; ok {
			s.BranchName, s.Title = e.BranchName, e.Title
		}
		out.Siblings = append(out.Siblings, s)
	}
	return out
}

// Format renders the context as prose for a system prompt. Returns "" for an
// empty context, so a caller can inject unconditionally.
//
// One least-opinionated default over the struct: facts plus the invariants the
// engine enforces, no workflow prescription. A consumer wanting different
// phrasing reads the struct.
func (p PromptContext) Format() string {
	if p.Kind != ContextWorktree || p.Worktree == nil {
		return ""
	}
	return p.Worktree.format()
}

func (w *WorktreeContext) format() string {
	var b strings.Builder
	b.WriteString("## Workspace: isolated worktree\n\n")
	fmt.Fprintf(&b, "This conversation is working in the git worktree %s", w.WorktreePath)
	if w.BranchName != "" {
		fmt.Fprintf(&b, " on branch %s", w.BranchName)
	}
	fmt.Fprintf(&b, ", cut from the repository %s", w.RepoPath)
	if w.SourceBranch != "" {
		fmt.Fprintf(&b, " (source branch %s)", w.SourceBranch)
	}
	b.WriteString(".\n")
	if w.Title != "" {
		fmt.Fprintf(&b, "\nWorktree label: %s\n", w.Title)
	}
	if w.Landed {
		b.WriteString("\nThis worktree is SEALED — its work has already landed in the source branch. All writes, edits, and Bash mutations are refused. The worktree is read-only. To continue work on this area, create a new worktree from the updated source branch.\n")
	} else {
		b.WriteString("\nWrites are confined to this worktree. Writing into the base repository or into another worktree of the same repository is refused, because it would interleave several conversations' work in one checkout and review could not attribute the changes afterwards. Directories outside this repository entirely are unaffected.\n")
	}

	if !w.Landed {
		// The branch-attachment invariant. Stated as an END STATE, never as a verb
		// blocklist: this worktree's history verbs (rebase, reset, stash, amend,
		// push) are exactly what the operator's own amend and squash workflows are
		// built from, and an earlier revision that forbade them broke all three.
		// What must not happen is the worktree being LEFT off its branch — the
		// failure that made a mid-rebase checkout vanish from the operator's panel.
		// Enforcement lives in two places (a narrow pre-execution refusal for
		// operations that change which branch the worktree holds, and a
		// post-execution attachment check that reports a detached HEAD or an
		// interrupted operation), so this text only has to state the obligation.
		b.WriteString("\nThis worktree holds one conversation's branch")
		if w.BranchName != "" {
			fmt.Fprintf(&b, " (%s)", w.BranchName)
		}
		b.WriteString(". Committing, amending, rebasing, resetting, stashing, cherry-picking, branch management, and pushing are all fine here. Switching the checkout to a different branch, deliberately detaching HEAD, and removing or moving the checkout are refused. End every turn with HEAD attached")
		if w.BranchName != "" {
			fmt.Fprintf(&b, " to %s", w.BranchName)
		}
		b.WriteString(": if a rebase or merge stops on a conflict, finish it (`--continue`) or unwind it (`--abort`) before you are done — a worktree left detached is reported as missing and a later sync reads the wrong commit.\n")

		if len(w.Siblings) > 0 {
			b.WriteString("\nOther worktrees of this repository (not writable from here):\n")
			for _, s := range w.Siblings {
				fmt.Fprintf(&b, "- %s", s.WorktreePath)
				if s.BranchName != "" {
					fmt.Fprintf(&b, " (%s)", s.BranchName)
				}
				if s.Title != "" {
					fmt.Fprintf(&b, " — %s", s.Title)
				}
				b.WriteString("\n")
			}
			b.WriteString("\nUse WorktreeList, WorktreeCommits, and WorktreeDiff to inspect what a sibling worktree has already built — commit history, diffs, unlanded work — without opening its directory. Check before starting work that might duplicate or conflict with what a sibling is already doing.\n")
		}
	}
	return b.String()
}
