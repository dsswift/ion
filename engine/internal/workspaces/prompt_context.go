// Workspace prompt context: the exact registry facts about the directory a
// conversation is running in, as a structured value plus a generic formatter.
//
// ── Why structured first, prose second ──────────────────────────────────────
// The engine owns the MECHANISM — reading the two records and stating what they
// say. It does not own the OPINION of how those facts should be phrased to a
// model, which is a harness concern that varies per consumer. So the model is
// the contract and the formatter is one least-opinionated default over it: a
// consumer that wants different prose reads the same struct and writes its own,
// with no need to re-derive anything from git or re-parse the records.
//
// ── Why the prose is deliberately thin ──────────────────────────────────────
// The formatter states facts and the two safety invariants the engine actually
// enforces (a bench edit is destroyed by the next assembly; a worktree
// conversation writes only inside its own worktree). It does NOT prescribe a
// workflow — which conversation should fix what, when to reassemble, how to
// review. Those are the harness's opinions, and hardcoding them here would
// force every consumer through one product's workflow. The line is: the engine
// explains what is true and what is refused; the harness decides what to do
// about it.
package workspaces

import (
	"fmt"
	"sort"
	"strings"
)

// ContextKind names what the conversation's directory is.
type ContextKind string

const (
	// ContextNone — a plain directory: no worktree, no bench.
	ContextNone ContextKind = ""
	// ContextWorktree — inside a registered worktree.
	ContextWorktree ContextKind = "worktree"
	// ContextBench — inside an integration bench.
	ContextBench ContextKind = "bench"
)

// PromptContext is the complete structured description of a conversation's
// workspace surroundings. Exactly one of Worktree / Bench is set, matching
// Kind; both are nil for ContextNone.
type PromptContext struct {
	Kind     ContextKind      `json:"kind"`
	Cwd      string           `json:"cwd"`
	Bench    *BenchContext    `json:"bench,omitempty"`
	Worktree *WorktreeContext `json:"worktree,omitempty"`
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
	// BenchPaths are the benches this worktree is enrolled in, so a
	// conversation can be told its work is being integrated elsewhere.
	BenchPaths []string `json:"benchPaths,omitempty"`
}

// SiblingContext is one other worktree of the same repository.
type SiblingContext struct {
	WorktreePath string `json:"worktreePath"`
	BranchName   string `json:"branchName,omitempty"`
	Title        string `json:"title,omitempty"`
}

// BenchContext describes an integration bench: what it was assembled from and
// which member worktrees own its content.
type BenchContext struct {
	BenchPath    string `json:"benchPath"`
	BenchBranch  string `json:"benchBranch,omitempty"`
	RepoPath     string `json:"repoPath"`
	SourceBranch string `json:"sourceBranch"`
	BaseSha      string `json:"baseSha,omitempty"`
	// LastAssembly is "assembled", "failed", or "" for unknown. Unknown is
	// carried through as unknown: claiming either outcome would be a fact the
	// record does not contain.
	LastAssembly      string `json:"lastAssembly,omitempty"`
	LastAssemblyError string `json:"lastAssemblyError,omitempty"`
	LastBuiltAt       int64  `json:"lastBuiltAt,omitempty"`
	// Members are the ENABLED members in merge order — the contributors whose
	// content is actually in the bench.
	Members []MemberContext `json:"members,omitempty"`
	// DisabledMembers are enrolled but skipped. Kept in a separate field, never
	// merged into Members: their content is NOT in the bench, and listing them
	// as contributors would attribute assembled bytes to work that never
	// arrived.
	DisabledMembers []MemberContext `json:"disabledMembers,omitempty"`
	// Warnings are facts that change how bench observations should be read
	// (failed assembly, stale pins, conflicts). Generic strings so a consumer
	// can surface them without interpreting a taxonomy.
	Warnings []string `json:"warnings,omitempty"`
}

// MemberContext is one enrolled worktree's contribution to a bench.
type MemberContext struct {
	WorktreePath string `json:"worktreePath"`
	BranchName   string `json:"branchName,omitempty"`
	Title        string `json:"title,omitempty"`
	Enabled      bool   `json:"enabled"`
	// PinnedRange is `pinnedBaseSha..pinnedSha` — the EXACT contribution the
	// assembly merged. The tip alone is not the contribution: a collision
	// introduced by an earlier commit in the range belongs to this member too.
	PinnedRange string `json:"pinnedRange,omitempty"`
	PinnedSha   string `json:"pinnedSha,omitempty"`
	PinnedBase  string `json:"pinnedBaseSha,omitempty"`
	// EmptyContribution is true when the member has committed nothing of its
	// own (equal base and tip), which is distinct from having landed.
	EmptyContribution bool `json:"emptyContribution,omitempty"`
	// Stale is true when the member's current tree differs from the pinned one:
	// the bench does NOT hold this worktree's current work.
	Stale bool `json:"stale,omitempty"`
	// StalenessKnown is false when the record lacks the tree hashes needed to
	// answer Stale at all. Reported so a consumer never reads an absent hash as
	// freshness.
	StalenessKnown bool     `json:"stalenessKnown"`
	Pin            string   `json:"pin,omitempty"`
	Merge          string   `json:"merge,omitempty"`
	Review         string   `json:"review,omitempty"`
	ConflictPaths  []string `json:"conflictPaths,omitempty"`
	ConflictsWith  []string `json:"conflictsWith,omitempty"`
	// MergeResolution is "replayed" when the merge succeeded only via a
	// recorded rerere resolution.
	MergeResolution string `json:"mergeResolution,omitempty"`
}

// PromptContextFor builds the structured workspace context for a directory.
// Returns a zero PromptContext (Empty) for a plain directory, a nil Checker, or
// an empty cwd — the caller injects nothing in that case.
func (c *Checker) PromptContextFor(cwd string) PromptContext {
	if c == nil || cwd == "" {
		return PromptContext{}
	}
	containment := c.Resolve(cwd)
	switch {
	case containment.Bench != nil:
		return PromptContext{Kind: ContextBench, Cwd: cwd, Bench: c.benchContext(containment.Bench)}
	case containment.Worktree != nil:
		return PromptContext{Kind: ContextWorktree, Cwd: cwd, Worktree: c.worktreeContext(containment.Worktree)}
	default:
		return PromptContext{}
	}
}

// worktreeContext enriches worktree containment with the registry's
// descriptive fields and the benches the worktree is enrolled in.
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
	for _, b := range c.reg.Benches() {
		if b.MemberFor(wc.WorktreePath) != nil {
			out.BenchPaths = append(out.BenchPaths, b.BenchPath)
		}
	}
	sort.Strings(out.BenchPaths)
	return out
}

// benchContext projects a bench record plus the worktree registry's titles into
// the structured context, and derives the warnings that change how observations
// made in the bench should be read.
func (c *Checker) benchContext(bench *BenchWorkspace) *BenchContext {
	out := &BenchContext{
		BenchPath:         bench.BenchPath,
		BenchBranch:       bench.BenchBranch,
		RepoPath:          bench.RepoPath,
		SourceBranch:      bench.SourceBranch,
		BaseSha:           bench.BaseSha,
		LastAssembly:      bench.LastAssembly,
		LastAssemblyError: bench.LastAssemblyError,
		LastBuiltAt:       bench.LastBuiltAt,
	}

	titles := make(map[string]string)
	for _, e := range c.reg.Worktrees() {
		if e.Title != "" {
			titles[e.WorktreePath] = e.Title
		}
	}

	for _, m := range bench.Members {
		mc := memberContext(m, titles[m.WorktreePath])
		if mc.Enabled {
			out.Members = append(out.Members, mc)
		} else {
			out.DisabledMembers = append(out.DisabledMembers, mc)
		}
	}
	out.Warnings = benchWarnings(bench)
	return out
}

func memberContext(m BenchMember, title string) MemberContext {
	return MemberContext{
		WorktreePath:      m.WorktreePath,
		BranchName:        m.BranchName,
		Title:             title,
		Enabled:           m.EnabledOrDefault(),
		PinnedRange:       m.PinnedRange(),
		PinnedSha:         m.PinnedSha,
		PinnedBase:        m.PinnedBase,
		EmptyContribution: m.EmptyContribution(),
		Stale:             m.Stale(),
		StalenessKnown:    m.StalenessKnown(),
		Pin:               m.Pin,
		Merge:             m.Merge,
		Review:            m.Review,
		ConflictPaths:     m.ConflictPaths,
		ConflictsWith:     m.ConflictsWith,
		MergeResolution:   m.MergeResolution,
	}
}

// benchWarnings derives the facts that make a bench observation misleading if
// unstated. Each is read from the record, never guessed from the tree.
func benchWarnings(bench *BenchWorkspace) []string {
	var warnings []string

	switch {
	case bench.AssemblyFailed():
		w := "The last assembly FAILED, so this bench was wiped to an empty tree and holds no member content. Anything built or tested here is not the enrolled combination."
		if bench.LastAssemblyError != "" {
			w += " Recorded error: " + bench.LastAssemblyError
		}
		warnings = append(warnings, w)
	case bench.LastAssembly == "":
		warnings = append(warnings, "The last assembly outcome is unknown for this bench (the record predates outcome tracking), so whether the tree matches the enrolled combination cannot be confirmed from the record.")
	}

	var stale, unknownStale []string
	for _, m := range bench.EnabledMembers() {
		switch {
		case m.Stale():
			stale = append(stale, m.BranchName)
		case !m.StalenessKnown():
			unknownStale = append(unknownStale, m.BranchName)
		}
	}
	if len(stale) > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"Pinned contributions are behind their worktrees for: %s. The bench holds the PINNED work, not the current work in those worktrees.",
			strings.Join(stale, ", ")))
	}
	if len(unknownStale) > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"Pin freshness is unknown for: %s (the record carries no tree hashes to compare).",
			strings.Join(unknownStale, ", ")))
	}

	for _, m := range bench.EnabledMembers() {
		if m.Merge == "conflicted" {
			w := fmt.Sprintf("Member %s last merged with CONFLICTS", m.BranchName)
			if len(m.ConflictsWith) > 0 {
				w += " against " + strings.Join(m.ConflictsWith, ", ")
			}
			if len(m.ConflictPaths) > 0 {
				w += " in " + strings.Join(m.ConflictPaths, ", ")
			}
			warnings = append(warnings, w+".")
		}
		if m.MergeResolution == "replayed" {
			warnings = append(warnings, fmt.Sprintf(
				"Member %s merged only because a recorded conflict resolution was replayed; that is deterministic but not the same fact as a clean merge.",
				m.BranchName))
		}
		if m.EmptyContribution() {
			warnings = append(warnings, fmt.Sprintf(
				"Member %s contributes nothing: its pinned range is empty, so it has committed no work of its own.",
				m.BranchName))
		}
	}
	return warnings
}

// Format renders the context as prose for a system prompt. Returns "" for an
// empty context, so a caller can inject unconditionally.
//
// One least-opinionated default over the struct: facts plus the invariants the
// engine enforces, no workflow prescription. A consumer wanting different
// phrasing reads the struct.
func (p PromptContext) Format() string {
	switch p.Kind {
	case ContextBench:
		if p.Bench == nil {
			return ""
		}
		return p.Bench.format()
	case ContextWorktree:
		if p.Worktree == nil {
			return ""
		}
		return p.Worktree.format()
	default:
		return ""
	}
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
		b.WriteString("\nThis worktree's work has already landed in its source branch.\n")
	}

	b.WriteString("\nWrites are confined to this worktree. Writing into the base repository or into another worktree of the same repository is refused, because it would interleave several conversations' work in one checkout and review could not attribute the changes afterwards. Directories outside this repository entirely are unaffected.\n")

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
	}
	if len(w.BenchPaths) > 0 {
		b.WriteString("\nThis worktree is enrolled as a member in:\n")
		for _, p := range w.BenchPaths {
			fmt.Fprintf(&b, "- %s\n", p)
		}
		b.WriteString("A bench integrates the PINNED commit of each member, so work committed here reaches a bench only when that member's pin is updated.\n")
	}
	return b.String()
}

func (bc *BenchContext) format() string {
	var b strings.Builder
	b.WriteString("## Workspace: integration bench\n\n")
	fmt.Fprintf(&b, "This conversation is working in the integration bench %s", bc.BenchPath)
	if bc.BenchBranch != "" {
		fmt.Fprintf(&b, " on branch %s", bc.BenchBranch)
	}
	fmt.Fprintf(&b, ". It is assembled from the source branch %s of %s", bc.SourceBranch, bc.RepoPath)
	if bc.BaseSha != "" {
		fmt.Fprintf(&b, " at %s", bc.BaseSha)
	}
	b.WriteString(", with each enabled member's pinned contribution merged on top.\n")

	b.WriteString("\nThe bench is disposable: its branch is recreated from scratch on every assembly, so a file written here and a commit made here are both destroyed by the next assembly and reach nobody. File writes and history-writing git commands are refused in the bench for that reason. Reading, building, testing, and staging are unaffected — running the assembled combination is what the bench is for.\n")

	if len(bc.Members) > 0 {
		b.WriteString("\nEnabled members, in merge order — each owns the content its pinned range contributed:\n")
		for i, m := range bc.Members {
			fmt.Fprintf(&b, "%d. %s\n", i+1, m.formatLine())
		}
	} else {
		b.WriteString("\nNo enabled members: this bench currently holds only its source branch.\n")
	}

	if len(bc.DisabledMembers) > 0 {
		b.WriteString("\nEnrolled but DISABLED — their work is not in this bench and they own none of its content:\n")
		for _, m := range bc.DisabledMembers {
			fmt.Fprintf(&b, "- %s\n", m.formatLine())
		}
	}

	if bc.LastAssembly != "" {
		fmt.Fprintf(&b, "\nLast assembly: %s", bc.LastAssembly)
		if bc.LastAssemblyError != "" {
			fmt.Fprintf(&b, " — %s", bc.LastAssemblyError)
		}
		b.WriteString("\n")
	}

	if len(bc.Warnings) > 0 {
		b.WriteString("\nFacts that change how observations made here should be read:\n")
		for _, w := range bc.Warnings {
			fmt.Fprintf(&b, "- %s\n", w)
		}
	}

	b.WriteString("\nAttribution of an assembled file to the member that contributed it is available through the WorkspaceAttribution tool, which answers from the recorded pinned ranges rather than from \"who last touched this file\". It is read-only and reports every candidate when more than one member changed the same file, including the specific lines each one changed.\n")
	return b.String()
}

func (m MemberContext) formatLine() string {
	var b strings.Builder
	if m.BranchName != "" {
		b.WriteString(m.BranchName)
	} else {
		b.WriteString(m.WorktreePath)
	}
	fmt.Fprintf(&b, " at %s", m.WorktreePath)
	if m.PinnedRange != "" {
		fmt.Fprintf(&b, ", pinned range %s", m.PinnedRange)
	} else if m.PinnedSha != "" {
		fmt.Fprintf(&b, ", pinned at %s with an unknown range start", m.PinnedSha)
	}
	if m.Title != "" {
		fmt.Fprintf(&b, " — %s", m.Title)
	}
	var flags []string
	if m.EmptyContribution {
		flags = append(flags, "empty contribution")
	}
	if m.Stale {
		flags = append(flags, "pin behind worktree")
	} else if !m.StalenessKnown {
		flags = append(flags, "pin freshness unknown")
	}
	if m.Pin != "" {
		flags = append(flags, "pin="+m.Pin)
	}
	if m.Merge != "" {
		flags = append(flags, "merge="+m.Merge)
	}
	if m.MergeResolution != "" {
		flags = append(flags, "resolution="+m.MergeResolution)
	}
	if m.Review != "" {
		flags = append(flags, "review="+m.Review)
	}
	if len(flags) > 0 {
		fmt.Fprintf(&b, " [%s]", strings.Join(flags, "; "))
	}
	return b.String()
}
