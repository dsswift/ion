// Read-only attribution: which member worktree owns a file — or a specific
// range of lines — in an assembled integration bench.
//
// ── The question this answers, and why precision matters ────────────────────
// A build fails in a bench. The failing file is assembled from a source branch
// plus every enabled member's pinned contribution, and the bench itself is not
// writable — so the only actionable answer is "this belongs to member X, edit
// it there". Getting that wrong sends an edit to the wrong worktree, where it
// is either irrelevant or actively harmful.
//
// The naive answer, "who last touched this file", is confidently wrong exactly
// when it matters: whenever two members change one file, whenever a member's
// tip commit touches a different file than the commit that introduced the
// problem, and whenever a line moved because an earlier member's hunk shifted
// it. So attribution asks the question the assembly actually asked:
//
//   - Per FILE: does the member's pinned RANGE (`pinnedBaseSha..pinnedSha`)
//     touch this path? The range, never the tip.
//   - Per LINE: blame the assembled tree, then decide for each blamed commit
//     whether it lies inside some member's pinned range, in the bench's base
//     history, or in an assembly merge commit. Blame is what makes this exact
//     under line shifts: it reports the commit that produced the line as it
//     exists NOW, so a hunk pushed down by an earlier member is still
//     attributed to its real author.
//
// ── Why it never guesses one owner ──────────────────────────────────────────
// Every outcome is explicit and every candidate is reported. Two members
// touching one file is `ambiguous` with both listed and their exact changed
// ranges, not a coin flip. Content that exists only because a conflict
// resolution was recorded in an assembly merge commit is `resolution`, not
// silently credited to whichever side won. A git failure is `unknown` with the
// error surfaced — a member whose diff could not be read is still LISTED, with
// its error, because a silently omitted member is indistinguishable from a
// member that genuinely does not own the file, and that is the one failure mode
// that produces a wrong redirect with full confidence.
//
// ── Read-only, and why that is structural ───────────────────────────────────
// Nothing here writes. Every git invocation is a query (blame, diff, rev-list,
// cat-file, merge-base), the bench is never modified, and the records are never
// written. That is what makes it safe to expose to a model in plan mode.
package workspaces

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// AttributionOutcome is the verdict for one attribution request. Exhaustive and
// explicit: there is no "probably" state, and a consumer switching on these
// values has covered every answer the engine can give.
type AttributionOutcome string

const (
	// OutcomeMember — exactly one enabled member owns the requested content.
	OutcomeMember AttributionOutcome = "member"
	// OutcomeAmbiguous — more than one origin contributes. Candidates lists
	// every one of them; the caller decides using the reported line ranges.
	OutcomeAmbiguous AttributionOutcome = "ambiguous"
	// OutcomeSource — no enabled member changed this content; it comes from the
	// bench's source branch. The fix belongs in a worktree cut from that branch.
	OutcomeSource AttributionOutcome = "source"
	// OutcomeResolution — the content exists because a conflict resolution was
	// recorded in an assembly merge commit, so it is not verbatim from any
	// single member. Editing a member may not reproduce it.
	OutcomeResolution AttributionOutcome = "resolution"
	// OutcomeUnknown — attribution could not be completed. Errors says why.
	// Never a silent fallback to a plausible owner.
	OutcomeUnknown AttributionOutcome = "unknown"
)

// AttributionRequest asks who owns a path, optionally narrowed to a line range.
type AttributionRequest struct {
	// BenchPath is any path inside the bench; the bench is resolved from it.
	BenchPath string `json:"benchPath"`
	// Path is the file in question, absolute or bench-relative.
	Path string `json:"path"`
	// StartLine / EndLine are 1-based and inclusive. Zero StartLine means the
	// whole file. EndLine zero with StartLine set means the single line.
	StartLine int `json:"startLine,omitempty"`
	EndLine   int `json:"endLine,omitempty"`
}

// LineRange is an inclusive 1-based line span.
type LineRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

func (r LineRange) String() string {
	if r.Start == r.End {
		return fmt.Sprintf("L%d", r.Start)
	}
	return fmt.Sprintf("L%d-%d", r.Start, r.End)
}

// Candidate statuses describe what a member's pinned contribution did to the
// file. Strings rather than an enum so an unrecognized future git status can be
// reported verbatim instead of collapsing into a wrong known value.
const (
	CandidateChanged = "changed"
	CandidateAdded   = "added"
	CandidateDeleted = "deleted"
	CandidateRenamed = "renamed"
	CandidateUnknown = "unknown"
)

// AttributionCandidate is one possible origin of the requested content, with
// everything a caller needs to choose between candidates itself.
type AttributionCandidate struct {
	WorktreePath string `json:"worktreePath"`
	BranchName   string `json:"branchName,omitempty"`
	Title        string `json:"title,omitempty"`
	// Enabled is always true for a bench contributor. A disabled member is
	// reported only in DisabledMembersTouching, never as a candidate, because
	// its content is not in the bench.
	Enabled     bool   `json:"enabled"`
	PinnedRange string `json:"pinnedRange,omitempty"`
	PinnedSha   string `json:"pinnedSha,omitempty"`
	PinnedBase  string `json:"pinnedBaseSha,omitempty"`
	// Status is what the pinned contribution did to this file.
	Status string `json:"status"`
	// RenamedFrom is the previous path when Status is renamed — the path to
	// edit in the member worktree may differ from the assembled path.
	RenamedFrom string `json:"renamedFrom,omitempty"`
	// Binary is true when git reports the change as binary, so no line ranges
	// exist for it and a line-scoped question cannot be answered.
	Binary bool `json:"binary,omitempty"`
	// ChangedRanges are the line spans this member's pinned contribution
	// changed, in the MEMBER's coordinates. Complete, never truncated.
	ChangedRanges []LineRange `json:"changedRanges,omitempty"`
	// MatchedLines are the requested lines this member owns in the ASSEMBLED
	// tree, established by blame. Populated only for a line-scoped request; it
	// is the precise answer, and ChangedRanges is the file-level context.
	MatchedLines []LineRange `json:"matchedLines,omitempty"`
	// Commits are the member commits blame attributed the matched lines to.
	Commits []string `json:"commits,omitempty"`
	// Stale is true when the member worktree has moved past its pin, so the
	// code in the worktree is not what the bench holds.
	Stale          bool   `json:"stale,omitempty"`
	StalenessKnown bool   `json:"stalenessKnown"`
	Pin            string `json:"pin,omitempty"`
	Merge          string `json:"merge,omitempty"`
	// Error is set when this member's contribution could not be read. The
	// candidate is still listed: dropping it would be indistinguishable from a
	// member that does not own the file.
	Error string `json:"error,omitempty"`
}

// AttributionResult is the complete JSON-ready answer. Nothing here is
// truncated or summarized: a caller that wants a short answer can shorten it,
// but a caller given a truncated answer cannot recover the rest.
type AttributionResult struct {
	Outcome AttributionOutcome `json:"outcome"`
	// BenchPath / BenchBranch / SourceBranch / BaseSha identify what was asked
	// about, so a result is interpretable without the request beside it.
	BenchPath    string `json:"benchPath"`
	BenchBranch  string `json:"benchBranch,omitempty"`
	RepoPath     string `json:"repoPath,omitempty"`
	SourceBranch string `json:"sourceBranch,omitempty"`
	BaseSha      string `json:"baseSha,omitempty"`
	// Path is the bench-relative path attribution ran against; CanonicalPath is
	// the absolute symlink-resolved form it was derived from.
	Path          string `json:"path"`
	CanonicalPath string `json:"canonicalPath,omitempty"`
	// RequestedLines echoes the validated line scope, absent for a whole-file
	// question.
	RequestedLines *LineRange `json:"requestedLines,omitempty"`
	// LineScoped reports whether the answer used blame (precise, shift-aware)
	// or file-level range diffing.
	LineScoped bool `json:"lineScoped"`
	// Candidates is every possible owner, ordered by merge order. Populated for
	// every outcome including source and unknown (empty for source).
	Candidates []AttributionCandidate `json:"candidates"`
	// SourceLines are requested lines that came from the source branch, and
	// ResolutionLines are those that exist only because of an assembly merge's
	// conflict resolution. Both reported alongside member candidates so a mixed
	// range is legible rather than reduced to "ambiguous".
	SourceLines     []LineRange `json:"sourceLines,omitempty"`
	ResolutionLines []LineRange `json:"resolutionLines,omitempty"`
	UnknownLines    []LineRange `json:"unknownLines,omitempty"`
	// DisabledMembersTouching names enrolled-but-disabled members whose pinned
	// range also touches this file. They own NO bench content — surfaced
	// because "the fix looks like it belongs to a member that is switched off"
	// is a real diagnosis, and silence there reads as "no such member".
	DisabledMembersTouching []AttributionCandidate `json:"disabledMembersTouching,omitempty"`
	// Binary / DeletedInBench describe the file itself in the assembled tree.
	Binary         bool `json:"binary,omitempty"`
	DeletedInBench bool `json:"deletedInBench,omitempty"`
	ExistsInBench  bool `json:"existsInBench"`
	// Warnings are facts that change how the answer should be read. Never a
	// substitute for an outcome.
	Warnings []string `json:"warnings,omitempty"`
	// Errors are git or record failures encountered while answering. A
	// non-empty Errors with a non-unknown outcome means the answer is partial:
	// what is reported is real, but a member may be missing detail.
	Errors []string `json:"errors,omitempty"`
	// Rejection is set when the request itself was refused (not a bench, path
	// outside the bench, traversal, unresolvable line range). Outcome is
	// unknown in that case and no git ran.
	Rejection string `json:"rejection,omitempty"`
}

// Attribute answers one attribution request. It never writes, never mutates the
// records, and never returns an error: every failure is expressed in the result
// (Rejection, Errors, OutcomeUnknown) so a consumer gets one shape to render
// and a model gets an actionable message instead of a stack trace.
func (c *Checker) Attribute(ctx context.Context, req AttributionRequest) AttributionResult {
	res := AttributionResult{Outcome: OutcomeUnknown, Path: req.Path}
	if c == nil {
		res.Rejection = "workspace containment is disabled, so bench attribution is unavailable"
		return res
	}

	bench := c.benchFor(canonicalizePath(req.BenchPath))
	if bench == nil {
		res.Rejection = fmt.Sprintf("%s is not inside a registered integration bench, so there is nothing to attribute against", req.BenchPath)
		logAttribution(res, req)
		return res
	}
	res.BenchPath = bench.BenchPath
	res.BenchBranch = bench.BenchBranch
	res.RepoPath = bench.RepoPath
	res.SourceBranch = bench.SourceBranch
	res.BaseSha = bench.BaseSha

	rel, canonical, rejection := c.resolveRequestPath(req, bench)
	if rejection != "" {
		res.Rejection = rejection
		logAttribution(res, req)
		return res
	}
	res.Path, res.CanonicalPath = rel, canonical

	lines, lineWarning, lineRejection := validateLineRange(req)
	if lineRejection != "" {
		res.Rejection = lineRejection
		logAttribution(res, req)
		return res
	}
	if lineWarning != "" {
		res.Warnings = append(res.Warnings, lineWarning)
	}
	res.RequestedLines = lines

	// Bench-level facts that make every later answer interpretable.
	res.Warnings = append(res.Warnings, benchWarnings(bench)...)
	if bench.BaseSha == "" {
		res.Warnings = append(res.Warnings, "The bench record carries no baseSha, so a member with no recorded pinnedBaseSha has no contribution range to diff and source-branch ancestry cannot be confirmed.")
	}

	c.describeBenchFile(ctx, bench, &res)
	c.collectCandidates(ctx, bench, &res)

	if lines != nil {
		c.attributeLines(ctx, bench, *lines, &res)
	}

	res.Outcome = decideOutcome(&res)
	logAttribution(res, req)
	return res
}

// resolveRequestPath turns the requested path into a bench-relative path,
// rejecting anything that is not genuinely inside the bench. Symlinks are
// resolved on both sides first: on macOS the recorded bench path and a resolved
// cwd routinely differ by /private, and a raw string comparison would reject
// legitimate paths as outside.
func (c *Checker) resolveRequestPath(req AttributionRequest, bench *BenchWorkspace) (rel, canonical, rejection string) {
	target := req.Path
	if target == "" {
		return "", "", "no path was given to attribute"
	}
	if strings.ContainsRune(target, 0) {
		return "", "", "the path contains a NUL byte and cannot name a file"
	}
	if !isAbsPath(target) {
		// Joined WITHOUT cleaning so a `..` segment survives to be classified as
		// a traversal rather than silently normalized into a plain outside path.
		target = joinRaw(bench.BenchPath, target)
	}

	rel, canonical, rej := resolveWithin(target, bench.BenchPath)
	switch rej {
	case "":
		return rel, canonical, ""
	case rejectTraversal:
		return "", canonical, fmt.Sprintf("%s resolves to %s, which escapes the bench %s; attribution answers only about files inside the bench", req.Path, canonical, bench.BenchPath)
	case rejectOutside:
		return "", canonical, fmt.Sprintf("%s resolves to %s, which is outside the bench %s; attribution answers only about files inside the bench", req.Path, canonical, bench.BenchPath)
	case rejectRelative:
		return "", canonical, fmt.Sprintf("%s could not be resolved to an absolute path inside the bench %s", req.Path, bench.BenchPath)
	default:
		return "", canonical, fmt.Sprintf("%s is not a usable path (%s)", req.Path, rej)
	}
}

// validateLineRange normalizes the 1-based inclusive request. An invalid range
// is REJECTED rather than silently widened to the whole file: a caller asking
// about lines 40-30 has a bug, and answering about the entire file would look
// like a successful answer to the question they think they asked.
func validateLineRange(req AttributionRequest) (lines *LineRange, warning, rejection string) {
	if req.StartLine == 0 && req.EndLine == 0 {
		return nil, "", ""
	}
	if req.StartLine == 0 && req.EndLine != 0 {
		return nil, "", fmt.Sprintf("endLine %d was given without a startLine; give both or neither", req.EndLine)
	}
	if req.StartLine < 0 || req.EndLine < 0 {
		return nil, "", "line numbers are 1-based and cannot be negative"
	}
	end := req.EndLine
	if end == 0 {
		end = req.StartLine
	}
	if end < req.StartLine {
		return nil, "", fmt.Sprintf("endLine %d is before startLine %d", req.EndLine, req.StartLine)
	}
	return &LineRange{Start: req.StartLine, End: end}, "", ""
}

// decideOutcome maps the gathered evidence onto exactly one outcome.
//
// The precedence is deliberate. A single member with no other origin is the
// only case that yields a confident `member`; ANY mixture — two members, a
// member plus source, a member plus an unreadable member — is `ambiguous`, so a
// caller is never handed one owner for content that has more than one. Nothing
// determined at all is `unknown`, never a fallback to the most likely member.
func decideOutcome(res *AttributionResult) AttributionOutcome {
	var owners int
	var failed int
	for _, cand := range res.Candidates {
		if cand.Error != "" {
			failed++
			continue
		}
		owners++
	}

	if res.LineScoped {
		matched := 0
		for _, cand := range res.Candidates {
			if len(cand.MatchedLines) > 0 {
				matched++
			}
		}
		switch {
		case len(res.UnknownLines) > 0 && matched == 0 && len(res.SourceLines) == 0 && len(res.ResolutionLines) == 0:
			return OutcomeUnknown
		case matched > 1:
			return OutcomeAmbiguous
		case matched == 1:
			if len(res.SourceLines) > 0 || len(res.ResolutionLines) > 0 || len(res.UnknownLines) > 0 || failed > 0 {
				return OutcomeAmbiguous
			}
			return OutcomeMember
		case len(res.ResolutionLines) > 0 && len(res.SourceLines) > 0:
			return OutcomeAmbiguous
		case len(res.ResolutionLines) > 0:
			if failed > 0 {
				return OutcomeAmbiguous
			}
			return OutcomeResolution
		case len(res.SourceLines) > 0:
			if failed > 0 {
				return OutcomeAmbiguous
			}
			return OutcomeSource
		default:
			return OutcomeUnknown
		}
	}

	switch {
	case owners > 1:
		return OutcomeAmbiguous
	case owners == 1:
		if failed > 0 {
			return OutcomeAmbiguous
		}
		return OutcomeMember
	case failed > 0:
		// Every member that could have owned it failed to read. Naming source
		// here would be a confident answer built on nothing.
		return OutcomeUnknown
	default:
		return OutcomeSource
	}
}

// sortRanges orders spans by start, so a reported set is stable regardless of
// the order blame produced them in.
func sortRanges(ranges []LineRange) []LineRange {
	sort.Slice(ranges, func(i, j int) bool {
		if ranges[i].Start != ranges[j].Start {
			return ranges[i].Start < ranges[j].Start
		}
		return ranges[i].End < ranges[j].End
	})
	return ranges
}

// coalesce merges adjacent and overlapping spans, so 12 consecutive owned lines
// read as L10-21 rather than twelve single-line entries.
func coalesce(lines []int) []LineRange {
	if len(lines) == 0 {
		return nil
	}
	sort.Ints(lines)
	var out []LineRange
	cur := LineRange{Start: lines[0], End: lines[0]}
	for _, n := range lines[1:] {
		if n == cur.End || n == cur.End+1 {
			cur.End = n
			continue
		}
		out = append(out, cur)
		cur = LineRange{Start: n, End: n}
	}
	return append(out, cur)
}
