// Attribution's git layer: the queries that turn the two records plus the
// assembled tree into candidates and line ownership.
//
// ── Why a separate runner from the guard's ──────────────────────────────────
// The containment guard's git runner is a fast, context-free `exec` on the
// refusal path: it runs a handful of cheap queries with a hard requirement that
// it cannot hang a tool call. Attribution is the opposite shape — a blame over a
// large file plus a diff per member, invoked by a model that may abandon the
// turn — so it takes a context and cancels. Sharing one runner would force
// either a cancellable guard (a refusal that can be aborted is not a guard) or
// an uncancellable blame (a stuck git holds the session). Two runners, two
// lifetimes.
package workspaces

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ctxGitRunner runs git in a directory under a cancellable context.
type ctxGitRunner func(ctx context.Context, dir string, args ...string) (string, error)

// runGitCtx is the production runner. stderr is captured and folded into the
// error: a bare "exit status 128" is unactionable, and the whole point of
// surfacing git errors is that the model can read what git objected to.
func runGitCtx(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return string(out), fmt.Errorf("%w: %s", err, firstLine(detail))
		}
		return string(out), err
	}
	return string(out), nil
}

// attrGit returns the context-aware runner, honoring a test override.
func (c *Checker) attrGit(ctx context.Context, dir string, args ...string) (string, error) {
	if c.gitCtx != nil {
		return c.gitCtx(ctx, dir, args...)
	}
	return runGitCtx(ctx, dir, args...)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func isAbsPath(p string) bool { return filepath.IsAbs(p) }

// describeBenchFile records what the file IS in the assembled tree: present or
// deleted, text or binary. A line-scoped question about a binary file has no
// answer, and a question about a path deleted in the bench is still answerable
// from history — both need stating rather than being discovered as a confusing
// empty result.
func (c *Checker) describeBenchFile(ctx context.Context, bench *BenchWorkspace, res *AttributionResult) {
	absolute := filepath.Join(bench.BenchPath, filepath.FromSlash(res.Path))
	res.ExistsInBench = pathExists(absolute)

	if !res.ExistsInBench {
		// Distinguish "tracked but deleted in the assembled tree" from "never
		// existed": the first is attributable from history, the second is a bad
		// path the caller should know about.
		out, err := c.attrGit(ctx, bench.BenchPath, "log", "-1", "--format=%H", "--diff-filter=D", "--", res.Path)
		switch {
		case err != nil:
			res.Errors = append(res.Errors, fmt.Sprintf("could not determine whether %s was deleted in the bench: %v", res.Path, err))
		case strings.TrimSpace(out) != "":
			res.DeletedInBench = true
			res.Warnings = append(res.Warnings, fmt.Sprintf("%s does not exist in the assembled bench tree; it was deleted in bench history. Attribution below is derived from the recorded contributions, not from the current tree.", res.Path))
		default:
			res.Warnings = append(res.Warnings, fmt.Sprintf("%s does not exist in the assembled bench tree and no bench commit deleted it, so it may never have been part of this assembly.", res.Path))
		}
		return
	}

	// `--numstat` reports `-\t-` for a binary path. Asked against the empty
	// tree so a file with no bench-history change still answers.
	out, err := c.attrGit(ctx, bench.BenchPath, "diff", "--numstat", "--no-renames", emptyTreeSha, "HEAD", "--", res.Path)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("could not determine whether %s is binary: %v", res.Path, err))
		return
	}
	for _, line := range nonEmptyLines(out) {
		if strings.HasPrefix(line, "-\t-\t") {
			res.Binary = true
			res.Warnings = append(res.Warnings, fmt.Sprintf("%s is a binary file: no line-level attribution exists for it, so ownership is reported per file only.", res.Path))
			break
		}
	}
}

// emptyTreeSha is git's well-known empty tree object, used to diff a path
// against nothing so an unchanged file still produces a numstat row.
const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// collectCandidates asks each enabled member whether its PINNED RANGE touches
// the file, and records what it did to it.
//
// A member whose diff cannot be read is appended WITH its error rather than
// skipped. That is the difference between "this member does not own the file"
// and "we could not tell", and collapsing the two is exactly how attribution
// produces a wrong redirect with full confidence.
func (c *Checker) collectCandidates(ctx context.Context, bench *BenchWorkspace, res *AttributionResult) {
	titles := map[string]string{}
	for _, e := range c.reg.Worktrees() {
		if e.Title != "" {
			titles[e.WorktreePath] = e.Title
		}
	}

	for _, m := range bench.Members {
		cand, touches := c.memberCandidate(ctx, bench, m, res, titles[m.WorktreePath])
		if !touches {
			continue
		}
		if m.EnabledOrDefault() {
			res.Candidates = append(res.Candidates, cand)
		} else {
			res.DisabledMembersTouching = append(res.DisabledMembersTouching, cand)
		}
	}

	if len(res.DisabledMembersTouching) > 0 {
		var names []string
		for _, d := range res.DisabledMembersTouching {
			names = append(names, d.BranchName)
		}
		res.Warnings = append(res.Warnings, fmt.Sprintf(
			"Disabled member(s) %s also change this file, but they are excluded from the assembly and own none of the bench's content.",
			strings.Join(names, ", ")))
	}
}

// memberCandidate builds one candidate. The bool reports whether the member's
// contribution is relevant at all — false means it genuinely does not touch the
// file AND nothing failed while determining that.
func (c *Checker) memberCandidate(ctx context.Context, bench *BenchWorkspace, m BenchMember, res *AttributionResult, title string) (AttributionCandidate, bool) {
	cand := AttributionCandidate{
		WorktreePath:   m.WorktreePath,
		BranchName:     m.BranchName,
		Title:          title,
		Enabled:        m.EnabledOrDefault(),
		PinnedRange:    m.PinnedRange(),
		PinnedSha:      m.PinnedSha,
		PinnedBase:     m.PinnedBase,
		Status:         CandidateUnknown,
		Stale:          m.Stale(),
		StalenessKnown: m.StalenessKnown(),
		Pin:            m.Pin,
		Merge:          m.Merge,
	}

	if m.PinnedSha == "" {
		cand.Error = "the member has no pinnedSha recorded, so its contribution cannot be diffed"
		res.Errors = append(res.Errors, fmt.Sprintf("member %s: %s", m.BranchName, cand.Error))
		return cand, true
	}
	base := m.PinnedBase
	if base == "" {
		base = bench.BaseSha
		if base == "" {
			cand.Error = "neither the member's pinnedBaseSha nor the bench's baseSha is recorded, so the contribution range is unknown"
			res.Errors = append(res.Errors, fmt.Sprintf("member %s: %s", m.BranchName, cand.Error))
			return cand, true
		}
		cand.PinnedBase = base
		cand.PinnedRange = base + ".." + m.PinnedSha
	}

	// `--find-renames` so a file the member renamed is attributed, and the
	// caller learns the path to edit in the worktree differs from the assembled
	// one. `-z` avoids quoting surprises on non-ASCII paths.
	out, err := c.attrGit(ctx, bench.BenchPath, "diff", "--name-status", "--find-renames", "-z", base, m.PinnedSha, "--", res.Path)
	if err != nil {
		cand.Error = fmt.Sprintf("git could not read this member's contribution: %v", err)
		res.Errors = append(res.Errors, fmt.Sprintf("member %s: %s", m.BranchName, cand.Error))
		return cand, true
	}
	status, renamedFrom, touches := parseNameStatusZ(out, res.Path)
	if !touches || status == CandidateAdded {
		// Rename detection needs a diff that can SEE both paths. A path-limited
		// diff excludes the rename source, so git has nothing to pair the
		// destination with and reports a plain Add — which would send the caller
		// to a file that does not exist in the member worktree under that name.
		// So an Add is re-checked against the unlimited diff, and a genuine
		// addition simply finds no rename and keeps its status.
		if renameStatus, from, isRename := c.detectRenameInto(ctx, bench, base, m.PinnedSha, res.Path); isRename {
			status, renamedFrom = renameStatus, from
		} else if !touches {
			return cand, false
		}
	}
	cand.Status = status
	cand.RenamedFrom = renamedFrom

	c.fillCandidateRanges(ctx, bench, base, m.PinnedSha, res, &cand)
	return cand, true
}

// detectRenameInto finds a rename whose DESTINATION is the requested path. A
// path-limited diff can miss it, because git records the change against the
// source path when the limit excludes it.
func (c *Checker) detectRenameInto(ctx context.Context, bench *BenchWorkspace, base, sha, rel string) (status, renamedFrom string, touches bool) {
	out, err := c.attrGit(ctx, bench.BenchPath, "diff", "--name-status", "--find-renames", "--diff-filter=R", "-z", base, sha)
	if err != nil {
		return "", "", false
	}
	fields := splitNul(out)
	for i := 0; i < len(fields); i++ {
		if !strings.HasPrefix(fields[i], "R") {
			continue
		}
		if i+2 >= len(fields) {
			break
		}
		from, to := fields[i+1], fields[i+2]
		i += 2
		if to == rel {
			return CandidateRenamed, from, true
		}
	}
	return "", "", false
}

// fillCandidateRanges records the line spans the member changed and whether the
// change is binary. A deleted or binary path has no line ranges, and saying so
// is the answer rather than an empty list that reads like "no changes".
func (c *Checker) fillCandidateRanges(ctx context.Context, bench *BenchWorkspace, base, sha string, res *AttributionResult, cand *AttributionCandidate) {
	numstat, err := c.attrGit(ctx, bench.BenchPath, "diff", "--numstat", "--find-renames", base, sha, "--", res.Path)
	if err == nil {
		for _, line := range nonEmptyLines(numstat) {
			if strings.HasPrefix(line, "-\t-\t") {
				cand.Binary = true
				break
			}
		}
	} else {
		res.Errors = append(res.Errors, fmt.Sprintf("member %s: could not determine binary status: %v", cand.BranchName, err))
	}
	if cand.Binary || cand.Status == CandidateDeleted {
		return
	}

	diff, err := c.attrGit(ctx, bench.BenchPath, "diff", "-U0", "--find-renames", base, sha, "--", res.Path)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("member %s: could not read changed line ranges: %v", cand.BranchName, err))
		return
	}
	cand.ChangedRanges = sortRanges(parseHunkRanges(diff))
}

// parseNameStatusZ reads a NUL-separated --name-status stream and reports what
// happened to rel.
func parseNameStatusZ(out, rel string) (status, renamedFrom string, touches bool) {
	fields := splitNul(out)
	for i := 0; i < len(fields); i++ {
		code := fields[i]
		if code == "" {
			continue
		}
		switch {
		case strings.HasPrefix(code, "R"), strings.HasPrefix(code, "C"):
			if i+2 >= len(fields) {
				return "", "", false
			}
			from, to := fields[i+1], fields[i+2]
			i += 2
			if to == rel || from == rel {
				return CandidateRenamed, from, true
			}
		default:
			if i+1 >= len(fields) {
				return "", "", false
			}
			path := fields[i+1]
			i++
			if path != rel {
				continue
			}
			switch code[0] {
			case 'A':
				return CandidateAdded, "", true
			case 'D':
				return CandidateDeleted, "", true
			case 'M', 'T':
				return CandidateChanged, "", true
			default:
				return CandidateUnknown, "", true
			}
		}
	}
	return "", "", false
}

func splitNul(out string) []string {
	var fields []string
	for _, f := range strings.Split(out, "\x00") {
		if f = strings.TrimSpace(f); f != "" {
			fields = append(fields, f)
		}
	}
	return fields
}

var hunkRangeRe = regexp.MustCompile(`^@@+ .*?\+(\d+)(?:,(\d+))? @@`)

// parseHunkRanges reads `-U0` hunk headers into line spans in the NEW file's
// coordinates. A zero-length hunk (`+12,0`) is a pure deletion at that point;
// it is reported as the single adjacent line so the span is never empty.
func parseHunkRanges(diff string) []LineRange {
	var out []LineRange
	for _, line := range strings.Split(diff, "\n") {
		m := hunkRangeRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		start, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		count := 1
		if m[2] != "" {
			if n, convErr := strconv.Atoi(m[2]); convErr == nil {
				count = n
			}
		}
		if count == 0 {
			out = append(out, LineRange{Start: start, End: start})
			continue
		}
		out = append(out, LineRange{Start: start, End: start + count - 1})
	}
	return out
}

// blameLine is one line's origin in the assembled tree.
type blameLine struct {
	Line   int
	Commit string
}

// attributeLines is the precise path: blame the assembled file, then classify
// each blamed commit against the recorded contribution ranges.
//
// Blame is what makes this exact under LINE SHIFTS. A member's hunk that landed
// at lines 40-45 in its own branch may sit at 58-63 in the bench because an
// earlier member inserted 18 lines above it. A range-diff answer would look for
// 58-63 in the member's diff, find nothing, and report the wrong owner or none.
// Blame reports the commit that produced each line AS IT EXISTS NOW, so the
// shift is already accounted for and the only remaining question is which
// member's range that commit falls in.
func (c *Checker) attributeLines(ctx context.Context, bench *BenchWorkspace, want LineRange, res *AttributionResult) {
	res.LineScoped = true

	if res.Binary {
		res.Errors = append(res.Errors, "a line range was requested for a binary file, which has no lines; the file-level answer above stands")
		return
	}
	if !res.ExistsInBench {
		res.Errors = append(res.Errors, fmt.Sprintf("a line range was requested for %s, which does not exist in the assembled bench tree; the file-level answer above stands", res.Path))
		return
	}

	blamed, err := c.blameRange(ctx, bench.BenchPath, res.Path, want)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("git blame failed for %s %s: %v", res.Path, want, err))
		res.UnknownLines = append(res.UnknownLines, want)
		return
	}
	if len(blamed) == 0 {
		res.Errors = append(res.Errors, fmt.Sprintf("git blame returned no lines for %s %s; the range may be past the end of the file", res.Path, want))
		res.UnknownLines = append(res.UnknownLines, want)
		return
	}

	// One classification per DISTINCT commit: a 200-line range typically has a
	// handful of origins, and asking per line would run hundreds of identical
	// ancestry queries.
	classifier := c.newCommitClassifier(bench)
	perMember := map[string][]int{}
	commitsByMember := map[string]map[string]bool{}
	var sourceLines, resolutionLines, unknownLines []int

	for _, bl := range blamed {
		class := classifier.classify(ctx, c, bl.Commit, res)
		switch class.kind {
		case commitMember:
			perMember[class.worktreePath] = append(perMember[class.worktreePath], bl.Line)
			if commitsByMember[class.worktreePath] == nil {
				commitsByMember[class.worktreePath] = map[string]bool{}
			}
			commitsByMember[class.worktreePath][bl.Commit] = true
		case commitSource:
			sourceLines = append(sourceLines, bl.Line)
		case commitResolution:
			resolutionLines = append(resolutionLines, bl.Line)
		default:
			unknownLines = append(unknownLines, bl.Line)
		}
	}

	// Attach matched lines to the candidates already gathered; a member blame
	// found but whose file-level diff did not name is appended, because blame is
	// the more precise instrument and dropping its answer would lose the owner.
	for path, lines := range perMember {
		idx := -1
		for i := range res.Candidates {
			if res.Candidates[i].WorktreePath == path {
				idx = i
				break
			}
		}
		if idx < 0 {
			cand := c.candidateFromBlame(bench, path)
			cand.Status = CandidateChanged
			res.Candidates = append(res.Candidates, cand)
			idx = len(res.Candidates) - 1
			res.Warnings = append(res.Warnings, fmt.Sprintf(
				"blame attributed lines in %s to member %s whose path-limited diff did not report the file (a rename or a mode change can do this); the blame answer is used.",
				res.Path, cand.BranchName))
		}
		res.Candidates[idx].MatchedLines = coalesce(lines)
		res.Candidates[idx].Commits = sortedKeys(commitsByMember[path])
	}

	res.SourceLines = coalesce(sourceLines)
	res.ResolutionLines = coalesce(resolutionLines)
	res.UnknownLines = append(res.UnknownLines, coalesce(unknownLines)...)

	if len(res.ResolutionLines) > 0 {
		res.Warnings = append(res.Warnings, "Some requested lines were produced by a conflict resolution recorded in an assembly merge commit. They are not verbatim from any single member, so editing one member may not reproduce them; the resolution itself is re-applied on each assembly.")
	}
}

// blameRange runs a porcelain blame over exactly the requested lines.
//
// `-w` ignores whitespace-only changes so a reformat does not steal ownership
// from the commit that wrote the logic. `-C` is deliberately NOT used: it
// detects copies across files, which would credit a member for content it moved
// rather than wrote, and the redirect must name where the line is maintained.
func (c *Checker) blameRange(ctx context.Context, benchPath, rel string, want LineRange) ([]blameLine, error) {
	out, err := c.attrGit(ctx, benchPath,
		"blame", "--porcelain", "-w",
		"-L", fmt.Sprintf("%d,%d", want.Start, want.End),
		"HEAD", "--", rel)
	if err != nil {
		return nil, err
	}
	return parseBlamePorcelain(out), nil
}

var blameHeaderRe = regexp.MustCompile(`^([0-9a-f]{7,40}) \d+ (\d+)(?: \d+)?$`)

// parseBlamePorcelain reads the header lines of porcelain blame output: each
// group starts `<sha> <orig-line> <final-line> [<count>]`.
func parseBlamePorcelain(out string) []blameLine {
	var lines []blameLine
	for _, line := range strings.Split(out, "\n") {
		m := blameHeaderRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		final, err := strconv.Atoi(m[2])
		if err != nil {
			continue
		}
		lines = append(lines, blameLine{Line: final, Commit: m[1]})
	}
	return lines
}

// candidateFromBlame builds a candidate for a member blame named but the
// file-level diff did not.
func (c *Checker) candidateFromBlame(bench *BenchWorkspace, worktreePath string) AttributionCandidate {
	cand := AttributionCandidate{WorktreePath: worktreePath, Status: CandidateUnknown}
	for _, m := range bench.Members {
		if m.WorktreePath != worktreePath {
			continue
		}
		cand.BranchName = m.BranchName
		cand.Enabled = m.EnabledOrDefault()
		cand.PinnedRange = m.PinnedRange()
		cand.PinnedSha = m.PinnedSha
		cand.PinnedBase = m.PinnedBase
		cand.Stale = m.Stale()
		cand.StalenessKnown = m.StalenessKnown()
		cand.Pin = m.Pin
		cand.Merge = m.Merge
		break
	}
	for _, e := range c.reg.Worktrees() {
		if e.WorktreePath == worktreePath {
			cand.Title = e.Title
			break
		}
	}
	return cand
}

func sortedKeys(set map[string]bool) []string {
	var out []string
	for k := range set {
		out = append(out, k)
	}
	sortStrings(out)
	return out
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func logAttribution(res AttributionResult, req AttributionRequest) {
	fields := map[string]any{
		"bench_path":  res.BenchPath,
		"path":        res.Path,
		"outcome":     string(res.Outcome),
		"line_scoped": res.LineScoped,
		"candidates":  len(res.Candidates),
	}
	if req.StartLine > 0 {
		fields["start_line"] = req.StartLine
		fields["end_line"] = req.EndLine
	}
	if res.Rejection != "" {
		fields["rejection"] = res.Rejection
		utils.LogWithFields(utils.LevelWarn, logTag, "bench attribution rejected", fields)
		return
	}
	if len(res.Errors) > 0 {
		fields["errors"] = res.Errors
	}
	if len(res.Warnings) > 0 {
		fields["warning_count"] = len(res.Warnings)
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "bench attribution resolved", fields)
}
