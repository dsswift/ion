package workspaces

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// RefusalKind names what the refused call targeted, so consumers and logs can
// distinguish the containment classes without parsing prose.
type RefusalKind string

type MergeDriver string

const (
	MergeDriverContinue MergeDriver = "continue"
	MergeDriverAbort    MergeDriver = "abort"
)

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
	// RefusalDisabledMember — a bench conversation targeted a member worktree
	// that is enrolled but EXCLUDED from the assembly. Its content is not in
	// the bench, so a failure observed there cannot originate from it.
	RefusalDisabledMember RefusalKind = "disabled_member"
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

// Checker answers "may this tool call proceed?" for workspace containment, and
// owns the read-only context and attribution queries over the same records.
// Nil-safe by convention at the call site (a nil *Checker means the feature is
// disabled), mirroring how the permission engine is threaded through RunConfig.
type Checker struct {
	reg *Registry
	// git runs a git command in a directory and returns stdout. Swappable for
	// tests; defaults to the real subprocess runner in bench.go. Deliberately
	// NOT context-aware: it runs on the refusal path, where a cancellable guard
	// is not a guard.
	git gitRunner
	// gitCtx is the cancellable runner attribution uses. Separate lifetime from
	// git: a blame over a large file must abort when the model abandons the
	// turn, which is the opposite requirement from the guard. nil means the real
	// runner (attribution_git.go).
	gitCtx ctxGitRunner
	// canonical memoizes symlink resolution for the record's ROOTS, which are
	// re-read on every gated call but only change when the records change.
	canonical canonicalCache
}

// NewChecker returns a Checker over the default registry (~/.ion records).
func NewChecker() *Checker {
	return &Checker{reg: NewRegistry(), git: runGit}
}

// NewCheckerAt returns a Checker reading records from dir. Test seam.
func NewCheckerAt(dir string) *Checker {
	return &Checker{reg: NewRegistryAt(dir), git: runGit}
}

// SetAttributionGitForTest swaps the cancellable git runner attribution uses,
// so a test can assert error surfacing without arranging a broken repository.
func (c *Checker) SetAttributionGitForTest(run func(ctx context.Context, dir string, args ...string) (string, error)) {
	c.gitCtx = run
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
//
// Both sides are canonicalized before comparison. On macOS this is not an edge
// case: /tmp and /var are symlinks to /private/..., so a recorded path and a
// resolved cwd routinely differ by spelling for the same directory — and a raw
// string comparison would classify a bench as a plain directory and pass every
// write it exists to refuse.
func (c *Checker) Resolve(dir string) Containment {
	if c == nil || dir == "" {
		return Containment{}
	}
	canonicalDir := c.canonical.get(dir)

	for i := range c.reg.Benches() {
		b := c.reg.Benches()[i]
		if c.within(canonicalDir, b.BenchPath) {
			return Containment{Bench: &b}
		}
	}

	entries := c.reg.Worktrees()
	for _, e := range entries {
		if !c.within(canonicalDir, e.WorktreePath) {
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

// within compares an already-canonical path against a record root, canonicalizing
// the root through the cache. Both sides canonical is the invariant every
// containment comparison in this package depends on.
func (c *Checker) within(canonicalPath, root string) bool {
	if canonicalPath == "" || root == "" {
		return false
	}
	// Compare against the raw root too: a root that cannot be resolved (a bench
	// whose directory was removed) still has to enforce, and its canonical form
	// falls back to the lexical one anyway.
	return isWithin(canonicalPath, c.canonical.get(root)) || isWithin(canonicalPath, filepath.Clean(root))
}

type MergeDriverCall struct {
	Driver    MergeDriver
	BenchPath string
}

// ClassifyMergeDriver identifies a Bash call that drives a merge in a bench.
// It performs command parsing only; merge state and resolution readiness remain
// Check's responsibility immediately before execution.
func (c *Checker) ClassifyMergeDriver(tool string, input map[string]interface{}, cwd string) MergeDriverCall {
	if c == nil || !isBash(tool) {
		return MergeDriverCall{}
	}
	command, ok := input["command"].(string)
	if !ok || command == "" {
		return MergeDriverCall{}
	}
	for _, segment := range resolveBashDestinations(command, cwd).Segments {
		if segment.MergeDriver == "" {
			continue
		}
		gitDir := effectiveDir(segment.Dir, cwd)
		if bench := c.benchFor(gitDir); bench != nil {
			return MergeDriverCall{Driver: MergeDriver(segment.MergeDriver), BenchPath: bench.BenchPath}
		}
	}
	return MergeDriverCall{}
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
	canonicalTarget := canonicalizePath(target)

	// Bench containment first — a bench is a worktree, so the ordering matters
	// for naming the right rule (see Resolve).
	if bench := c.benchFor(canonicalTarget); bench != nil {
		// Resolve-once carve-out: an edit to a path that is UNMERGED in the
		// bench's in-progress merge is the resolution itself — the artifact
		// git rerere records when the merge commits.
		if c.mergeInProgress(bench.BenchPath) && c.isUnmergedPath(bench.BenchPath, canonicalTarget) {
			return nil
		}
		owners := c.attributeOwners(bench, canonicalTarget)
		return &Refusal{
			Kind:   RefusalBenchWrite,
			Target: canonicalTarget,
			Owners: owners,
			Reason: benchWriteReason(canonicalTarget, bench, owners),
		}
	}

	// A conversation whose cwd is a BENCH writes into the member worktrees the
	// bench is assembled from. That is the entire remediation the bench refusal
	// names, so it must be reachable — see benchOriginRefusal.
	if containment.Bench != nil {
		return c.benchOriginRefusal(containment.Bench, canonicalTarget)
	}

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

// benchOriginRefusal decides a write from a BENCH conversation to a target
// outside that bench.
//
// ── Why an enrolled member destination must pass ────────────────────────────
// The bench write refusal names its own remediation: "make the change at
// <member worktree>, commit it there, then update that member in the bench."
// A conversation diagnosing an assembled failure runs IN the bench — that is
// where the failing build is — so if bench-origin writes were refused
// everywhere outside the bench, the remediation the guard prints would itself be
// refused. The rule would then have no compliant path at all, which is how a
// guard stops being a guard and becomes something to work around.
//
// ── Why only ENABLED and only ENROLLED ─────────────────────────────────────
// The permission is scoped to exactly the worktrees whose content is in the
// bench being diagnosed:
//
//   - An ENROLLED, ENABLED member owns bench content. A fix routed there is the
//     fix reaching the code the bench actually built, and the next assembly
//     carries it.
//   - A DISABLED member is enrolled but excluded from the assembly. Its content
//     is NOT in the bench, so a failure observed in the bench cannot originate
//     there, and an edit routed to it would be a change to unrelated work
//     justified by evidence that does not apply to it.
//   - An ARBITRARY worktree of the same repo is not a member at all. Writing
//     there from a bench conversation is the same interleaving defect the
//     worktree rule exists to prevent: another conversation owns that checkout.
//   - The SOURCE CHECKOUT (the main repository the bench was cut from) is never
//     a valid destination. Landing work directly in the source branch bypasses
//     the whole integration model, and every conversation sharing that checkout
//     gets an unattributable dirty tree.
//
// Directories that are none of these — /tmp, ~/.ion, an unrelated repository —
// pass, exactly as they do for a worktree conversation. This is not a cwd jail.
func (c *Checker) benchOriginRefusal(bench *BenchWorkspace, target string) *Refusal {
	// An enrolled member's worktree: allowed when enabled, refused when not.
	for i := range bench.Members {
		m := bench.Members[i]
		if !c.within(target, m.WorktreePath) {
			continue
		}
		if m.EnabledOrDefault() {
			utils.LogWithFields(utils.LevelInfo, logTag, "bench-origin write into enrolled member allowed", map[string]any{
				"bench_path":    bench.BenchPath,
				"member_branch": m.BranchName,
				"member_path":   m.WorktreePath,
				"target":        target,
			})
			return nil
		}
		return &Refusal{
			Kind:   RefusalDisabledMember,
			Target: target,
			Reason: disabledMemberReason(target, bench, m),
		}
	}

	// The source checkout the bench integrates into.
	if bench.RepoPath != "" && c.within(target, bench.RepoPath) {
		return &Refusal{
			Kind:   RefusalBaseRepo,
			Target: target,
			Reason: benchSourceCheckoutReason(target, bench),
		}
	}

	// Any other worktree of the same repository: enrolled in nothing here, and
	// owned by another conversation.
	for _, e := range c.reg.Worktrees() {
		if e.RepoPath != bench.RepoPath || !c.within(target, e.WorktreePath) {
			continue
		}
		return &Refusal{
			Kind:   RefusalSiblingWorktree,
			Target: target,
			Reason: nonMemberWorktreeReason(target, bench, e),
		}
	}

	return nil
}

// benchFor returns the bench containing path, or nil. path is canonicalized
// here so callers can pass a raw path safely; passing an already-canonical path
// is a cache hit.
func (c *Checker) benchFor(path string) *BenchWorkspace {
	canonical := c.canonical.get(path)
	for i := range c.reg.Benches() {
		b := c.reg.Benches()[i]
		if c.within(canonical, b.BenchPath) {
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
	b.WriteString(" Writes into an enrolled, enabled member worktree are permitted from this bench conversation, so the redirect above needs no new conversation.")
	b.WriteString(attributionHint)
	b.WriteString(" Reading, building, and testing in the bench are unaffected.")
	return b.String()
}

// attributionHint names the read-only tool that answers ownership precisely.
// Every bench refusal carries it: the refusal states an owner derived from
// file-level ranges, and a caller editing specific lines has a more exact
// question available — one that accounts for line shifts and reports every
// candidate rather than one guess.
const attributionHint = " For a precise answer — including which member owns a specific line range, every candidate when more than one member changed the file, and whether the content came from the source branch or from a recorded conflict resolution — use the WorkspaceAttribution tool, which is read-only."

// disabledMemberReason explains why an enrolled-but-excluded member is not a
// valid destination for a fix diagnosed in the bench.
func disabledMemberReason(target string, bench *BenchWorkspace, m BenchMember) string {
	return fmt.Sprintf(
		"Refused: %s is inside the member worktree %s (%s), which is enrolled in the bench %s but DISABLED. A disabled member is skipped during assembly, so none of its work is in the bench and a failure observed there cannot originate from it — an edit here would change unrelated work on evidence that does not apply to it. Attribute the failing content to an enabled member first; writes into enabled member worktrees are permitted from this bench conversation.%s",
		target, m.WorktreePath, m.BranchName, bench.BenchPath, attributionHint)
}

// benchSourceCheckoutReason explains why the repository the bench integrates
// into is never a write destination from a bench conversation.
func benchSourceCheckoutReason(target string, bench *BenchWorkspace) string {
	return fmt.Sprintf(
		"Refused: %s is inside the source checkout %s that the bench %s integrates into. Writing there commits straight onto %s, bypassing the integration model entirely, and leaves every conversation sharing that checkout with a dirty tree no review can attribute. Route the change to the enabled member worktree that owns the content — those writes are permitted from this bench conversation — or, when the content comes from %s itself, to a worktree cut from %s.%s",
		target, bench.RepoPath, bench.BenchPath, bench.SourceBranch, bench.SourceBranch, bench.SourceBranch, attributionHint)
}

// nonMemberWorktreeReason explains why an unenrolled worktree of the same
// repository is not reachable from a bench conversation.
func nonMemberWorktreeReason(target string, bench *BenchWorkspace, e WorktreeEntry) string {
	label := e.BranchName
	if label == "" {
		label = e.WorktreePath
	}
	return fmt.Sprintf(
		"Refused: %s is inside the worktree %s (%s), which is NOT enrolled as a member of the bench %s. It belongs to another conversation, and writing there would interleave two conversations' work in one checkout — the same defect worktree isolation exists to prevent. Only enrolled, enabled member worktrees of this bench are writable from here.%s",
		target, e.WorktreePath, label, bench.BenchPath, attributionHint)
}
