package workspaces

// Attribution behaviour: the outcomes, the precision claims, and the failure
// modes. Every test here runs against the real-git fixture in
// attribution_fixture_test.go, because each property being asserted is a
// property of blame/ancestry/merge commits rather than of this package's
// bookkeeping.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ─── Line-level precision: the shift case ────────────────────────────────────

// THE precision test. alpha edits app.txt line 8; beta then inserts 5 lines
// above it, so in the assembled bench that content sits at line 13. An answer
// derived from alpha's own diff coordinates would look for line 13 in a diff
// that only mentions line 8 and report the wrong owner (or none). Blame over
// the assembled tree is what makes the shifted line still resolve to alpha.
func TestAttributionResolvesShiftedLineToItsRealOwner(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/beta")

	shifted := f.lineOf(t, "app.txt", "line 08 changed by alpha")
	if shifted == 8 {
		t.Fatalf("fixture did not shift the line; the test cannot prove shift-awareness")
	}

	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: shifted})

	if res.Outcome != OutcomeMember {
		t.Fatalf("want a single member owner for the shifted line, got %s", describeResult(res))
	}
	owner := candidateFor(t, res, "wt/alpha")
	if !rangesContain(owner.MatchedLines, shifted) {
		t.Fatalf("alpha must own assembled line %d: %s", shifted, describeResult(res))
	}
	if len(owner.Commits) == 0 {
		t.Fatalf("the owning commit must be reported so the claim is checkable: %s", describeResult(res))
	}
	// The tip-only shortcut's failure is pinned explicitly: alpha's TIP commit
	// touches only alpha_only.txt, so any implementation that asked about the
	// tip would not have named alpha here at all.
	if owner.Status != CandidateChanged {
		t.Fatalf("alpha's contribution RANGE changes app.txt even though its tip does not; status = %s", owner.Status)
	}
}

// beta's own inserted line resolves to beta, so the shift test above is not
// passing by accident of every line resolving to alpha.
func TestAttributionResolvesInsertingMemberToItself(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/beta")

	header := f.lineOf(t, "app.txt", "beta header 3")
	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: header})

	if res.Outcome != OutcomeMember {
		t.Fatalf("want member outcome, got %s", describeResult(res))
	}
	if !rangesContain(candidateFor(t, res, "wt/beta").MatchedLines, header) {
		t.Fatalf("beta must own its own inserted line %d: %s", header, describeResult(res))
	}
}

// ─── Source content ──────────────────────────────────────────────────────────

// A line no member touched belongs to the source branch, and the outcome says
// so explicitly rather than reporting "no owner found".
func TestAttributionReportsSourceOwnedLine(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/beta")

	untouched := f.lineOf(t, "app.txt", "line 11")
	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: untouched})

	if res.Outcome != OutcomeSource {
		t.Fatalf("an untouched line comes from the source branch: %s", describeResult(res))
	}
	if !rangesContain(res.SourceLines, untouched) {
		t.Fatalf("sourceLines must name line %d: %s", untouched, describeResult(res))
	}
}

// A whole FILE no member touched is source-owned with zero candidates.
func TestAttributionReportsSourceOwnedFile(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/beta")

	res := f.attribute(AttributionRequest{Path: "source_only.txt"})

	if res.Outcome != OutcomeSource {
		t.Fatalf("want source outcome, got %s", describeResult(res))
	}
	if len(res.Candidates) != 0 {
		t.Fatalf("a source-owned file has no member candidates: %s", describeResult(res))
	}
	if res.LineScoped {
		t.Error("a whole-file request must not report itself as line-scoped")
	}
}

// ─── Ambiguity: every candidate, never a guess ───────────────────────────────

// Two members changing one file is `ambiguous` with BOTH listed and each one's
// exact changed ranges — not a coin flip, and not one owner with the other
// dropped.
func TestAttributionReportsEveryCandidateForSharedFile(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/gamma")

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	if res.Outcome != OutcomeAmbiguous {
		t.Fatalf("two members touching one file is ambiguous: %s", describeResult(res))
	}
	if len(res.Candidates) != 2 {
		t.Fatalf("both members must be listed: %s", describeResult(res))
	}
	for _, branch := range []string{"wt/alpha", "wt/gamma"} {
		cand := candidateFor(t, res, branch)
		if len(cand.ChangedRanges) == 0 {
			t.Errorf("%s must report the line ranges it changed, so the caller can choose: %s", branch, describeResult(res))
		}
	}
}

// A line-scoped question inside a shared file is NOT ambiguous: that is the
// whole point of the line scope. alpha and gamma both change app.txt, but only
// one owns any given line.
func TestAttributionDisambiguatesSharedFileByLine(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/gamma")

	gammaLine := f.lineOf(t, "app.txt", "line 03 changed by gamma")
	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: gammaLine})

	if res.Outcome != OutcomeMember {
		t.Fatalf("a single line in a shared file has one owner: %s", describeResult(res))
	}
	if !rangesContain(candidateFor(t, res, "wt/gamma").MatchedLines, gammaLine) {
		t.Fatalf("gamma must own line %d: %s", gammaLine, describeResult(res))
	}
	if hasCandidate(res, "wt/alpha") && len(candidateFor(t, res, "wt/alpha").MatchedLines) > 0 {
		t.Fatalf("alpha must not be credited with gamma's line: %s", describeResult(res))
	}
}

// A range spanning two members' lines reports BOTH with their own matched
// spans, so a caller editing that range knows it must split the fix.
func TestAttributionSplitsRangeAcrossTwoOwners(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/gamma")

	gammaLine := f.lineOf(t, "app.txt", "line 03 changed by gamma")
	alphaLine := f.lineOf(t, "app.txt", "line 08 changed by alpha")
	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: gammaLine, EndLine: alphaLine})

	if res.Outcome != OutcomeAmbiguous {
		t.Fatalf("a range spanning two owners is ambiguous: %s", describeResult(res))
	}
	if !rangesContain(candidateFor(t, res, "wt/gamma").MatchedLines, gammaLine) {
		t.Errorf("gamma's line missing from its matched set: %s", describeResult(res))
	}
	if !rangesContain(candidateFor(t, res, "wt/alpha").MatchedLines, alphaLine) {
		t.Errorf("alpha's line missing from its matched set: %s", describeResult(res))
	}
	// The source lines between the two edits are reported too, so the answer
	// accounts for every requested line rather than only the interesting ones.
	if len(res.SourceLines) == 0 {
		t.Errorf("intervening untouched lines must be reported as source: %s", describeResult(res))
	}
}

// ─── Conflict resolution ─────────────────────────────────────────────────────

// Content that exists only because a conflict resolution was recorded in an
// assembly MERGE commit is `resolution`, not silently credited to whichever
// side won. Editing one member may not reproduce it, which is precisely why the
// distinction is load-bearing.
func TestAttributionReportsResolutionOwnedLine(t *testing.T) {
	f := newAttrFixture(t)
	app := filepath.Join(f.benchPath, "app.txt")

	// Two members that change THE SAME line in different ways.
	gitRun(t, f.benchPath, "switch", "-c", "wt/left", f.baseSha)
	lines := readLines(t, app)
	lines[5] = "line 06 from left"
	writeLines(t, app, lines)
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "left")
	leftPin := strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))

	gitRun(t, f.benchPath, "switch", "-c", "wt/right", f.baseSha)
	lines = readLines(t, app)
	lines[5] = "line 06 from right"
	writeLines(t, app, lines)
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "right")
	rightPin := strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))

	// Assemble: merge left cleanly, then merge right with a resolution that is
	// neither side's content.
	gitRun(t, f.benchPath, "switch", "-C", "ion/bench/main", f.baseSha)
	gitRun(t, f.benchPath, "merge", "--no-ff", "-m", "assembly: merge left", leftPin)
	if err := gitTry(f.benchPath, "merge", "--no-ff", "-m", "assembly: merge right", rightPin); err == nil {
		t.Fatal("expected the second merge to conflict")
	}
	lines = readLines(t, app)
	lines[5] = "line 06 reconciled by the resolution"
	writeLines(t, app, lines)
	gitRun(t, f.benchPath, "add", "app.txt")
	gitRun(t, f.benchPath, "commit", "--no-edit")

	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/left", "branchName": "wt/left", "enabled": true,
			"pinnedSha": leftPin, "pinnedBaseSha": f.baseSha, "merge": "merged"},
		{"worktreePath": "/wt/right", "branchName": "wt/right", "enabled": true,
			"pinnedSha": rightPin, "pinnedBaseSha": f.baseSha, "merge": "conflicted",
			"conflictPaths": []string{"app.txt"}, "conflictsWith": []string{"wt/left"}},
	}, nil)

	resolved := f.lineOf(t, "app.txt", "reconciled by the resolution")
	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: resolved})

	if res.Outcome != OutcomeResolution {
		t.Fatalf("a line produced by an assembly merge's resolution is not any single member's: %s", describeResult(res))
	}
	if !rangesContain(res.ResolutionLines, resolved) {
		t.Fatalf("resolutionLines must name line %d: %s", resolved, describeResult(res))
	}
	// The warning is what tells a caller that editing one member may not
	// reproduce the line — the actionable half of the outcome.
	if !containsAny(res.Warnings, "conflict resolution") {
		t.Errorf("a resolution outcome must warn that the content is not verbatim from one member: %v", res.Warnings)
	}
}

// ─── Disabled members ────────────────────────────────────────────────────────

// A disabled member's content is NOT in the bench, so it is never a candidate —
// but it IS reported separately, because "the fix looks like it belongs to a
// member that is switched off" is a real diagnosis and silence reads as "no
// such member".
func TestAttributionSeparatesDisabledMembersFromCandidates(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/alpha", "branchName": "wt/alpha", "enabled": true,
			"pinnedSha": f.pins["wt/alpha"], "pinnedBaseSha": f.baseSha},
		{"worktreePath": "/wt/gamma", "branchName": "wt/gamma", "enabled": false,
			"pinnedSha": f.pins["wt/gamma"], "pinnedBaseSha": f.baseSha},
	}, nil)

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	if hasCandidate(res, "wt/gamma") {
		t.Fatalf("a disabled member owns no bench content and must not be a candidate: %s", describeResult(res))
	}
	if len(res.DisabledMembersTouching) != 1 || res.DisabledMembersTouching[0].BranchName != "wt/gamma" {
		t.Fatalf("the disabled member that touches the file must still be surfaced: %+v", res.DisabledMembersTouching)
	}
	if !containsAny(res.Warnings, "excluded from the assembly") {
		t.Errorf("a warning must explain that the disabled member owns none of the bench: %v", res.Warnings)
	}
	// With gamma excluded, alpha is the sole owner: the disabled member must not
	// have made the answer ambiguous.
	if res.Outcome != OutcomeMember {
		t.Fatalf("a disabled member must not turn a single-owner answer ambiguous: %s", describeResult(res))
	}
}

// ─── Rename, delete, binary ──────────────────────────────────────────────────

// A member that RENAMED the file is attributed, and the previous path is
// reported — the path to edit in the member worktree differs from the assembled
// one, so a redirect without it sends the caller to a file that is not there.
func TestAttributionReportsRenameWithPreviousPath(t *testing.T) {
	f := newAttrFixture(t)

	gitRun(t, f.benchPath, "switch", "-c", "wt/renamer", f.baseSha)
	gitRun(t, f.benchPath, "mv", "app.txt", "renamed.txt")
	// A content change alongside the rename, so git's rename detection has a
	// similarity score to work with and the hunk ranges are non-empty.
	lines := readLines(t, filepath.Join(f.benchPath, "renamed.txt"))
	lines[0] = "line 01 touched after the rename"
	writeLines(t, filepath.Join(f.benchPath, "renamed.txt"), lines)
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "renamer: move app.txt to renamed.txt")
	pin := strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))

	gitRun(t, f.benchPath, "switch", "-C", "ion/bench/main", f.baseSha)
	gitRun(t, f.benchPath, "merge", "--no-ff", "-m", "assembly: merge renamer", pin)
	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/renamer", "branchName": "wt/renamer", "enabled": true,
			"pinnedSha": pin, "pinnedBaseSha": f.baseSha},
	}, nil)

	res := f.attribute(AttributionRequest{Path: "renamed.txt"})

	if res.Outcome != OutcomeMember {
		t.Fatalf("the renaming member owns the renamed path: %s", describeResult(res))
	}
	cand := candidateFor(t, res, "wt/renamer")
	if cand.Status != CandidateRenamed {
		t.Fatalf("status must be renamed, got %s: %s", cand.Status, describeResult(res))
	}
	if cand.RenamedFrom != "app.txt" {
		t.Fatalf("renamedFrom must name the previous path, got %q", cand.RenamedFrom)
	}
}

// A path DELETED in the assembled tree is still attributable from history, and
// the result says the file is not there rather than returning a bare empty
// answer that reads like "nothing owns it".
func TestAttributionHandlesFileDeletedInBench(t *testing.T) {
	f := newAttrFixture(t)

	gitRun(t, f.benchPath, "switch", "-c", "wt/deleter", f.baseSha)
	gitRun(t, f.benchPath, "rm", "source_only.txt")
	gitRun(t, f.benchPath, "commit", "-m", "deleter: remove source_only.txt")
	pin := strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))

	gitRun(t, f.benchPath, "switch", "-C", "ion/bench/main", f.baseSha)
	gitRun(t, f.benchPath, "merge", "--no-ff", "-m", "assembly: merge deleter", pin)
	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/deleter", "branchName": "wt/deleter", "enabled": true,
			"pinnedSha": pin, "pinnedBaseSha": f.baseSha},
	}, nil)

	res := f.attribute(AttributionRequest{Path: "source_only.txt"})

	if res.ExistsInBench {
		t.Fatal("the file was deleted in the assembly; existsInBench must be false")
	}
	if !res.DeletedInBench {
		t.Fatalf("a tracked-then-deleted path must be reported as deleted, not merely absent: %s", describeResult(res))
	}
	cand := candidateFor(t, res, "wt/deleter")
	if cand.Status != CandidateDeleted {
		t.Fatalf("status must be deleted, got %s", cand.Status)
	}
	if len(cand.ChangedRanges) != 0 {
		t.Errorf("a deleted file has no line ranges in the new tree: %v", cand.ChangedRanges)
	}
}

// A line-scoped request against a deleted file cannot be answered by blame, and
// says so in Errors while the file-level answer still stands.
func TestAttributionRefusesLineScopeOnDeletedFile(t *testing.T) {
	f := newAttrFixture(t)

	gitRun(t, f.benchPath, "switch", "-c", "wt/deleter", f.baseSha)
	gitRun(t, f.benchPath, "rm", "source_only.txt")
	gitRun(t, f.benchPath, "commit", "-m", "deleter: remove")
	pin := strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))
	gitRun(t, f.benchPath, "switch", "-C", "ion/bench/main", f.baseSha)
	gitRun(t, f.benchPath, "merge", "--no-ff", "-m", "assembly", pin)
	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/deleter", "branchName": "wt/deleter", "enabled": true,
			"pinnedSha": pin, "pinnedBaseSha": f.baseSha},
	}, nil)

	res := f.attribute(AttributionRequest{Path: "source_only.txt", StartLine: 1})

	if !containsAny(res.Errors, "does not exist in the assembled bench tree") {
		t.Fatalf("a line request on a deleted file must say why it cannot be answered: %s", describeResult(res))
	}
	// The file-level answer survives: the member is still named.
	if !hasCandidate(res, "wt/deleter") {
		t.Fatalf("the file-level answer must stand: %s", describeResult(res))
	}
}

// A BINARY file has no lines. Ownership is reported per file, and a line-scoped
// question is answered with an explicit error instead of a fabricated span.
func TestAttributionHandlesBinaryFile(t *testing.T) {
	f := newAttrFixture(t)

	blob := []byte{0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42}
	gitRun(t, f.benchPath, "switch", "-c", "wt/binary", f.baseSha)
	if err := os.WriteFile(filepath.Join(f.benchPath, "asset.bin"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, f.benchPath, "add", "-A")
	gitRun(t, f.benchPath, "commit", "-m", "binary: add asset")
	pin := strings.TrimSpace(gitRun(t, f.benchPath, "rev-parse", "HEAD"))

	gitRun(t, f.benchPath, "switch", "-C", "ion/bench/main", f.baseSha)
	gitRun(t, f.benchPath, "merge", "--no-ff", "-m", "assembly: merge binary", pin)
	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/binary", "branchName": "wt/binary", "enabled": true,
			"pinnedSha": pin, "pinnedBaseSha": f.baseSha},
	}, nil)

	res := f.attribute(AttributionRequest{Path: "asset.bin"})
	if !res.Binary {
		t.Fatalf("asset.bin must be reported as binary: %s", describeResult(res))
	}
	if res.Outcome != OutcomeMember {
		t.Fatalf("a binary file still has a file-level owner: %s", describeResult(res))
	}
	if !containsAny(res.Warnings, "binary file") {
		t.Errorf("a binary result must warn that no line-level attribution exists: %v", res.Warnings)
	}

	lineScoped := f.attribute(AttributionRequest{Path: "asset.bin", StartLine: 1, EndLine: 3})
	if !containsAny(lineScoped.Errors, "binary file, which has no lines") {
		t.Fatalf("a line range on a binary file must be refused explicitly: %s", describeResult(lineScoped))
	}
}

// ─── Git errors: never a silent member omission ──────────────────────────────

// The single most dangerous failure mode. A member whose diff cannot be read
// must still be LISTED with its error: dropping it is indistinguishable from
// "this member does not own the file", which produces a wrong redirect with
// full confidence.
func TestAttributionListsMemberWhoseDiffFailedRatherThanOmittingIt(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha", "wt/gamma")

	// Fail exactly the diff for gamma's pin, leave everything else real.
	real := runGitCtx
	gammaPin := f.pins["wt/gamma"]
	f.checker.SetAttributionGitForTest(func(ctx context.Context, dir string, args ...string) (string, error) {
		joined := strings.Join(args, " ")
		if strings.HasPrefix(joined, "diff") && strings.Contains(joined, gammaPin) {
			return "", errors.New("fatal: bad object " + gammaPin)
		}
		return real(ctx, dir, args...)
	})

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	cand := candidateFor(t, res, "wt/gamma")
	if cand.Error == "" {
		t.Fatalf("the failing member must carry its error, not be silently dropped: %s", describeResult(res))
	}
	if !strings.Contains(cand.Error, "bad object") {
		t.Errorf("the git error must be surfaced verbatim enough to act on: %q", cand.Error)
	}
	if !containsAny(res.Errors, "bad object") {
		t.Errorf("the result-level error list must carry it too: %v", res.Errors)
	}
	// A read that failed cannot yield a confident single owner.
	if res.Outcome == OutcomeMember {
		t.Fatalf("one member unreadable means the answer is not confident: %s", describeResult(res))
	}
}

// When EVERY member read fails, the outcome is `unknown` — never `source`,
// which would be a confident claim built on nothing.
func TestAttributionIsUnknownWhenEveryMemberReadFails(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	real := runGitCtx
	f.checker.SetAttributionGitForTest(func(ctx context.Context, dir string, args ...string) (string, error) {
		if strings.HasPrefix(strings.Join(args, " "), "diff --name-status") {
			return "", errors.New("fatal: not a git repository")
		}
		return real(ctx, dir, args...)
	})

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	if res.Outcome != OutcomeUnknown {
		t.Fatalf("all reads failing must be unknown, never source: %s", describeResult(res))
	}
}

// A blame failure is reported and the requested lines land in UnknownLines, so
// the caller learns which lines have no answer instead of receiving a truncated
// one that looks complete.
func TestAttributionSurfacesBlameFailure(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	real := runGitCtx
	f.checker.SetAttributionGitForTest(func(ctx context.Context, dir string, args ...string) (string, error) {
		if len(args) > 0 && args[0] == "blame" {
			return "", errors.New("fatal: file has only 12 lines")
		}
		return real(ctx, dir, args...)
	})

	res := f.attribute(AttributionRequest{Path: "app.txt", StartLine: 4, EndLine: 6})

	if !containsAny(res.Errors, "git blame failed") {
		t.Fatalf("a blame failure must be surfaced: %s", describeResult(res))
	}
	if !rangesContain(res.UnknownLines, 5) {
		t.Fatalf("the unanswerable lines must be reported as unknown: %s", describeResult(res))
	}
	if res.Outcome != OutcomeUnknown {
		t.Fatalf("no line answered means unknown: %s", describeResult(res))
	}
}

// A missing member object is reported as such rather than as a quiet "this
// member does not own it". A garbage-collected pin is the realistic cause.
func TestAttributionSurfacesMissingMemberObject(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	// A pin that is a well-formed sha but not present in the repository.
	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/ghost", "branchName": "wt/ghost", "enabled": true,
			"pinnedSha": "0000000000000000000000000000000000000001", "pinnedBaseSha": f.baseSha},
	}, nil)

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	cand := candidateFor(t, res, "wt/ghost")
	if cand.Error == "" {
		t.Fatalf("a member with an unresolvable pin must report the failure: %s", describeResult(res))
	}
	if res.Outcome != OutcomeUnknown {
		t.Fatalf("the only member being unreadable means unknown: %s", describeResult(res))
	}
}

// ─── Missing base / no range ─────────────────────────────────────────────────

// A bench with no baseSha and a member with no pinnedBaseSha has no contribution
// range to diff. That is stated as an error on the candidate and a warning on
// the result, not silently treated as "no changes".
func TestAttributionReportsMissingContributionRange(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/alpha", "branchName": "wt/alpha", "enabled": true,
			"pinnedSha": f.pins["wt/alpha"]},
	}, map[string]any{"baseSha": ""})

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	if !containsAny(res.Warnings, "no baseSha") {
		t.Fatalf("a bench with no baseSha must warn: %v", res.Warnings)
	}
	cand := candidateFor(t, res, "wt/alpha")
	if cand.Error == "" || !strings.Contains(cand.Error, "range") {
		t.Fatalf("a member with no derivable range must say so: %q", cand.Error)
	}
	if res.Outcome != OutcomeUnknown {
		t.Fatalf("no range means no answer: %s", describeResult(res))
	}
}

// A member with no pinnedSha at all is listed with its error rather than
// skipped, for the same reason a failed diff is.
func TestAttributionReportsMemberWithNoPin(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")

	f.writeRecord(t, []map[string]any{
		{"worktreePath": "/wt/unpinned", "branchName": "wt/unpinned", "enabled": true},
	}, nil)

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	cand := candidateFor(t, res, "wt/unpinned")
	if !strings.Contains(cand.Error, "no pinnedSha") {
		t.Fatalf("an unpinned member must report exactly that: %q", cand.Error)
	}
}

func containsAny(haystack []string, needle string) bool {
	for _, h := range haystack {
		if strings.Contains(h, needle) {
			return true
		}
	}
	return false
}

// ─── Worktree registry join ──────────────────────────────────────────────────

// A candidate carries the operator-facing TITLE of the owning worktree, joined
// from the worktree registry. A redirect that names only a path and a branch
// makes the caller guess which piece of work it is being sent into; the title is
// the label the operator already recognizes.
func TestAttributionJoinsWorktreeTitleIntoCandidates(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")
	f.writeWorktreeEntries(t, []map[string]any{
		{"worktreePath": "/wt/alpha", "repoPath": f.repo, "branchName": "wt/alpha",
			"title": "fix the streaming retry loop"},
	})

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	if candidateFor(t, res, "wt/alpha").Title != "fix the streaming retry loop" {
		t.Fatalf("the owning worktree's title must be joined in: %s", describeResult(res))
	}
}

// A member with no registry entry still attributes — the title is decoration,
// never a precondition. A missing entry silently dropping the candidate would be
// the same defect as a silent member omission.
func TestAttributionSucceedsWhenWorktreeRegistryHasNoEntry(t *testing.T) {
	f := newAttrFixture(t)
	f.buildMembers(t)
	f.assemble(t, "wt/alpha")
	f.writeWorktreeEntries(t, []map[string]any{})

	res := f.attribute(AttributionRequest{Path: "app.txt"})

	if res.Outcome != OutcomeMember {
		t.Fatalf("a missing registry entry must not affect attribution: %s", describeResult(res))
	}
	if candidateFor(t, res, "wt/alpha").Title != "" {
		t.Error("no entry means no title, not a fabricated one")
	}
}
