// Commit classification: deciding what a blamed commit IS relative to the
// assembly.
//
// ── The three answers, and why the third one exists ─────────────────────────
// A commit blame reports in an assembled bench is one of:
//
//	member      — reachable from a member's pinned tip but not from its pinned
//	              base. That is precisely "inside the contribution range", which
//	              is the same question the assembly's merge asked.
//	source      — reachable from the bench's base sha. It came with the source
//	              branch, so the fix belongs in a worktree cut from that branch,
//	              not in any member.
//	resolution  — a MERGE commit produced by the assembly itself. Its content is
//	              not verbatim from either parent: it is what a conflict
//	              resolution decided. Crediting it to a member would be wrong in
//	              the specific way that matters — the line exists because of how
//	              two members were reconciled, and editing one member alone may
//	              not reproduce it.
//
// The third case is why "is this commit in member X's range" is not sufficient
// on its own. Assembly merges conflicting members, and `git blame` attributes
// resolved hunks to the merge commit rather than to either side. Without an
// explicit resolution answer, those lines would fall through to `unknown` (an
// honest non-answer) or, worse, be assigned to whichever member's range happens
// to contain a parent.
//
// ── Why ancestry, not range-diff, decides membership ────────────────────────
// `git merge-base --is-ancestor` answers the containment question directly and
// cheaply, and it is correct in the case a `rev-list` of the range would get
// wrong: the assembly's merge may commit member content under a sha that is not
// literally listed in `base..tip` if the member's history was rewritten between
// pin and assembly. Ancestry from the PINNED TIP is the durable relation.
package workspaces

import (
	"context"
	"fmt"
)

type commitKind int

const (
	commitUnknown commitKind = iota
	commitMember
	commitSource
	commitResolution
)

type commitClass struct {
	kind         commitKind
	worktreePath string
}

// commitClassifier memoizes classification for one attribution call. A blamed
// range of 200 lines typically has a handful of distinct origins, and each
// classification costs several git queries — so the cache is what keeps a
// line-scoped answer to a few dozen subprocesses instead of hundreds.
type commitClassifier struct {
	bench *BenchWorkspace
	cache map[string]commitClass
}

func (c *Checker) newCommitClassifier(bench *BenchWorkspace) *commitClassifier {
	return &commitClassifier{bench: bench, cache: map[string]commitClass{}}
}

// classify decides what one blamed commit is. Order matters:
//
//  1. Merge commits first. An assembly merge is a resolution regardless of what
//     its parents are reachable from, and testing member ancestry first would
//     misfile it under whichever member's range contains a parent.
//  2. Member ranges next, in merge order, because a member's contribution is the
//     most specific and most actionable answer.
//  3. Source last, since base ancestry is the broadest relation — a member
//     commit is frequently ALSO an ancestor of nothing but is tested after the
//     narrower questions so precedence never hands a member's line to source.
func (cl *commitClassifier) classify(ctx context.Context, c *Checker, commit string, res *AttributionResult) commitClass {
	if hit, ok := cl.cache[commit]; ok {
		return hit
	}
	class := cl.compute(ctx, c, commit, res)
	cl.cache[commit] = class
	return class
}

func (cl *commitClassifier) compute(ctx context.Context, c *Checker, commit string, res *AttributionResult) commitClass {
	bench := cl.bench

	parents, err := c.commitParents(ctx, bench.BenchPath, commit)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("could not read parents of %s: %v", short(commit), err))
		return commitClass{kind: commitUnknown}
	}
	if len(parents) > 1 {
		// An assembly merge. Whether its resolved content matches one side is
		// not knowable from the commit graph, and guessing would be the exact
		// confident-and-wrong answer this package refuses to give.
		return commitClass{kind: commitResolution}
	}

	for _, m := range bench.Members {
		if !m.EnabledOrDefault() || m.PinnedSha == "" {
			continue
		}
		inRange, rangeErr := c.commitInContribution(ctx, bench, m, commit)
		if rangeErr != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("could not test whether %s is in member %s's contribution: %v", short(commit), m.BranchName, rangeErr))
			continue
		}
		if inRange {
			return commitClass{kind: commitMember, worktreePath: m.WorktreePath}
		}
	}

	if bench.BaseSha != "" {
		isAncestor, ancErr := c.isAncestor(ctx, bench.BenchPath, commit, bench.BaseSha)
		if ancErr != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("could not test whether %s is in the bench base: %v", short(commit), ancErr))
			return commitClass{kind: commitUnknown}
		}
		if isAncestor {
			return commitClass{kind: commitSource}
		}
	}

	return commitClass{kind: commitUnknown}
}

// commitInContribution reports whether commit lies inside the member's pinned
// contribution range: reachable from the pinned tip, and NOT reachable from the
// pinned base.
//
// Both halves are required. Reachable-from-tip alone would include the entire
// source-branch history behind the member, making every source commit look like
// every member's. Not-reachable-from-base alone would include unrelated
// branches. The pair is exactly the range the assembly merged.
func (c *Checker) commitInContribution(ctx context.Context, bench *BenchWorkspace, m BenchMember, commit string) (bool, error) {
	reachable, err := c.isAncestor(ctx, bench.BenchPath, commit, m.PinnedSha)
	if err != nil {
		return false, err
	}
	if !reachable {
		return false, nil
	}

	base := m.PinnedBase
	if base == "" {
		base = bench.BaseSha
	}
	if base == "" {
		// No range start recorded. Reachable-from-tip is all that can be said,
		// and reporting it as membership would credit the member with the whole
		// source history behind it. The caller already surfaces the missing-base
		// warning; the honest answer here is "not established".
		return false, fmt.Errorf("no contribution range start recorded for member %s", m.BranchName)
	}
	inBase, err := c.isAncestor(ctx, bench.BenchPath, commit, base)
	if err != nil {
		return false, err
	}
	return !inBase, nil
}

// isAncestor wraps `git merge-base --is-ancestor`, whose exit code IS the
// answer: 0 yes, 1 no, anything else a real failure. A missing object exits
// 128, which must surface as an error rather than as a quiet "no" — a
// garbage-collected or never-fetched member sha would otherwise silently drop
// that member from every answer.
func (c *Checker) isAncestor(ctx context.Context, dir, maybeAncestor, descendant string) (bool, error) {
	if _, err := c.attrGit(ctx, dir, "merge-base", "--is-ancestor", maybeAncestor, descendant); err != nil {
		if code, ok := exitCode(err); ok && code == 1 {
			return false, nil
		}
		// Distinguish a missing object explicitly: it is the most common real
		// cause and the least obvious from a bare exit status.
		if missing, checkErr := c.objectMissing(ctx, dir, maybeAncestor, descendant); checkErr == nil && missing != "" {
			return false, fmt.Errorf("object %s is not present in the bench repository: %w", short(missing), err)
		}
		return false, err
	}
	return true, nil
}

// objectMissing returns the first of the given revisions the repository cannot
// resolve, or "" when all resolve.
func (c *Checker) objectMissing(ctx context.Context, dir string, revs ...string) (string, error) {
	for _, rev := range revs {
		if _, err := c.attrGit(ctx, dir, "cat-file", "-e", rev+"^{commit}"); err != nil {
			return rev, nil
		}
	}
	return "", nil
}

// commitParents returns the parent shas of a commit.
func (c *Checker) commitParents(ctx context.Context, dir, commit string) ([]string, error) {
	out, err := c.attrGit(ctx, dir, "rev-list", "-1", "--parents", commit)
	if err != nil {
		return nil, err
	}
	fields := splitFields(out)
	if len(fields) == 0 {
		return nil, fmt.Errorf("no rev-list output for %s", short(commit))
	}
	return fields[1:], nil
}

func splitFields(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		switch r {
		case ' ', '\t', '\n', '\r':
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
		default:
			cur += string(r)
		}
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

func short(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}
