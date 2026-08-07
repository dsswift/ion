/**
 * Line-level attribution: blame the assembled tree, classify each blamed
 * commit, and decide the final outcome.
 *
 * Ported from engine/internal/workspaces/attribution_git.go (attributeLines,
 * blameRange) and attribution_commits.go (the commit classifier), plus
 * attribution.go's decideOutcome — split from bench-attribution.ts at the
 * file/line seam to stay under the 600-line cap.
 *
 * ── Commit classification: the three answers, and why the third exists ──────
 * A commit blame reports in an assembled bench is one of:
 *
 *   member      — reachable from a member's pinned tip but not from its pinned
 *                 base. That is precisely "inside the contribution range",
 *                 which is the same question the assembly's merge asked.
 *   source      — reachable from the bench's base sha. It came with the source
 *                 branch, so the fix belongs in a worktree cut from that
 *                 branch, not in any member.
 *   resolution  — a MERGE commit produced by the assembly itself. Its content
 *                 is not verbatim from either parent: it is what a conflict
 *                 resolution decided. Crediting it to a member would be wrong
 *                 in the specific way that matters — the line exists because
 *                 of how two members were reconciled, and editing one member
 *                 alone may not reproduce it.
 *
 * The third case is why "is this commit in member X's range" is not sufficient
 * on its own. Assembly merges conflicting members, and `git blame` attributes
 * resolved hunks to the merge commit rather than to either side. Without an
 * explicit resolution answer, those lines would fall through to `unknown` (an
 * honest non-answer) or, worse, be assigned to whichever member's range happens
 * to contain a parent.
 *
 * ── Why ancestry, not range-diff, decides membership ────────────────────────
 * `git merge-base --is-ancestor` answers the containment question directly and
 * cheaply, and it is correct in the case a `rev-list` of the range would get
 * wrong: the assembly's merge may commit member content under a sha that is
 * not literally listed in `base..tip` if the member's history was rewritten
 * between pin and assembly. Ancestry from the PINNED TIP is the durable
 * relation.
 */
import type { IntegrationMember, IntegrationWorkspace } from '../../shared/types'
import {
  type AttributionOutcome, type AttributionResult, type LineRange,
  CandidateChanged, addError, addWarning, attrGit, baseCandidate, coalesce,
  rangeString, shortSha, splitFields,
} from './bench-attribution-support'

// ── Blame ────────────────────────────────────────────────────────────────────

/** One line's origin in the assembled tree. */
interface BlameLine {
  line: number
  commit: string
}

const blameHeaderRe = /^([0-9a-f]{7,40}) \d+ (\d+)(?: \d+)?$/

/**
 * Read the header lines of porcelain blame output: each group starts
 * `<sha> <orig-line> <final-line> [<count>]`.
 */
export function parseBlamePorcelain(out: string): BlameLine[] {
  const lines: BlameLine[] = []
  for (const line of out.split('\n')) {
    const m = blameHeaderRe.exec(line)
    if (!m) continue
    const final = parseInt(m[2], 10)
    if (Number.isNaN(final)) continue
    lines.push({ line: final, commit: m[1] })
  }
  return lines
}

/**
 * Run a porcelain blame over exactly the requested lines.
 *
 * `-w` ignores whitespace-only changes so a reformat does not steal ownership
 * from the commit that wrote the logic. `-C` is deliberately NOT used: it
 * detects copies across files, which would credit a member for content it
 * moved rather than wrote, and the redirect must name where the line is
 * maintained.
 */
function blameRange(benchPath: string, rel: string, want: LineRange): { lines?: BlameLine[]; error?: string } {
  const out = attrGit(benchPath, [
    'blame', '--porcelain', '-w',
    '-L', `${want.start},${want.end}`,
    'HEAD', '--', rel,
  ])
  if (out.error) return { error: out.error }
  return { lines: parseBlamePorcelain(out.out) }
}

// ── Commit classification ───────────────────────────────────────────────────

type CommitKind = 'unknown' | 'member' | 'source' | 'resolution'

interface CommitClass {
  kind: CommitKind
  worktreePath?: string
}

/**
 * Memoizes classification for one attribution call. A blamed range of 200
 * lines typically has a handful of distinct origins, and each classification
 * costs several git subprocesses — the cache is what keeps a line-scoped
 * answer to a few dozen subprocesses instead of hundreds.
 */
class CommitClassifier {
  private readonly cache = new Map<string, CommitClass>()

  constructor(private readonly bench: IntegrationWorkspace) {}

  classify(commit: string, res: AttributionResult): CommitClass {
    const hit = this.cache.get(commit)
    if (hit) return hit
    const cls = this.compute(commit, res)
    this.cache.set(commit, cls)
    return cls
  }

  /**
   * Decide what one blamed commit is. Order matters:
   *
   *  1. Merge commits first. An assembly merge is a resolution regardless of
   *     what its parents are reachable from, and testing member ancestry first
   *     would misfile it under whichever member's range contains a parent.
   *  2. Member ranges next, in merge order, because a member's contribution is
   *     the most specific and most actionable answer.
   *  3. Source last, since base ancestry is the broadest relation — tested
   *     after the narrower questions so precedence never hands a member's line
   *     to source.
   */
  private compute(commit: string, res: AttributionResult): CommitClass {
    const bench = this.bench

    const parents = commitParents(bench.benchPath, commit)
    if (parents.error !== undefined) {
      addError(res, `could not read parents of ${shortSha(commit)}: ${parents.error}`)
      return { kind: 'unknown' }
    }
    if (parents.parents.length > 1) {
      // An assembly merge. Whether its resolved content matches one side is
      // not knowable from the commit graph, and guessing would be the exact
      // confident-and-wrong answer this module refuses to give.
      return { kind: 'resolution' }
    }

    for (const m of bench.members) {
      if (!m.enabled || !m.pinnedSha) continue
      const inRange = commitInContribution(bench, m, commit)
      if (inRange.error !== undefined) {
        addError(res, `could not test whether ${shortSha(commit)} is in member ${m.branchName}'s contribution: ${inRange.error}`)
        continue
      }
      if (inRange.yes) return { kind: 'member', worktreePath: m.worktreePath }
    }

    if (bench.baseSha) {
      const anc = isAncestor(bench.benchPath, commit, bench.baseSha)
      if (anc.error !== undefined) {
        addError(res, `could not test whether ${shortSha(commit)} is in the bench base: ${anc.error}`)
        return { kind: 'unknown' }
      }
      if (anc.yes) return { kind: 'source' }
    }

    return { kind: 'unknown' }
  }
}

/**
 * Whether commit lies inside the member's pinned contribution range:
 * reachable from the pinned tip, and NOT reachable from the pinned base.
 *
 * Both halves are required. Reachable-from-tip alone would include the entire
 * source-branch history behind the member, making every source commit look
 * like every member's. Not-reachable-from-base alone would include unrelated
 * branches. The pair is exactly the range the assembly merged.
 */
function commitInContribution(
  bench: IntegrationWorkspace, m: IntegrationMember, commit: string,
): { yes: boolean; error?: string } {
  const reachable = isAncestor(bench.benchPath, commit, m.pinnedSha)
  if (reachable.error !== undefined) return { yes: false, error: reachable.error }
  if (!reachable.yes) return { yes: false }

  const base = m.pinnedBaseSha || bench.baseSha
  if (!base) {
    // No range start recorded. Reachable-from-tip is all that can be said,
    // and reporting it as membership would credit the member with the whole
    // source history behind it. The caller already surfaces the missing-base
    // warning; the honest answer here is "not established".
    return { yes: false, error: `no contribution range start recorded for member ${m.branchName}` }
  }
  const inBase = isAncestor(bench.benchPath, commit, base)
  if (inBase.error !== undefined) return { yes: false, error: inBase.error }
  return { yes: !inBase.yes }
}

/**
 * Wrap `git merge-base --is-ancestor`, whose exit code IS the answer: 0 yes,
 * 1 no, anything else a real failure. A missing object exits 128, which must
 * surface as an error rather than as a quiet "no" — a garbage-collected or
 * never-fetched member sha would otherwise silently drop that member from
 * every answer.
 */
function isAncestor(dir: string, maybeAncestor: string, descendant: string): { yes: boolean; error?: string } {
  const out = attrGit(dir, ['merge-base', '--is-ancestor', maybeAncestor, descendant])
  if (out.error === null) return { yes: true }
  if (out.code === 1) return { yes: false }
  // Distinguish a missing object explicitly: it is the most common real cause
  // and the least obvious from a bare exit status.
  const missing = objectMissing(dir, maybeAncestor, descendant)
  if (missing) {
    return { yes: false, error: `object ${shortSha(missing)} is not present in the bench repository: ${out.error}` }
  }
  return { yes: false, error: out.error }
}

/** The first of the given revisions the repository cannot resolve, or "". */
function objectMissing(dir: string, ...revs: string[]): string {
  for (const rev of revs) {
    const out = attrGit(dir, ['cat-file', '-e', `${rev}^{commit}`])
    if (out.error !== null) return rev
  }
  return ''
}

/** The parent shas of a commit. */
function commitParents(dir: string, commit: string): { parents: string[]; error?: string } {
  const out = attrGit(dir, ['rev-list', '-1', '--parents', commit])
  if (out.error !== null) return { parents: [], error: out.error }
  const fields = splitFields(out.out)
  if (fields.length === 0) return { parents: [], error: `no rev-list output for ${shortSha(commit)}` }
  return { parents: fields.slice(1) }
}

// ── Line attribution ─────────────────────────────────────────────────────────

/**
 * The precise path: blame the assembled file, then classify each blamed
 * commit against the recorded contribution ranges.
 *
 * Blame is what makes this exact under LINE SHIFTS. A member's hunk that
 * landed at lines 40-45 in its own branch may sit at 58-63 in the bench
 * because an earlier member inserted 18 lines above it. A range-diff answer
 * would look for 58-63 in the member's diff, find nothing, and report the
 * wrong owner (or none). Blame reports the commit that produced each line AS
 * IT EXISTS NOW, so the shift is already accounted for and the only remaining
 * question is which member's range that commit falls in.
 */
export function attributeLines(
  bench: IntegrationWorkspace, want: LineRange, res: AttributionResult,
): void {
  res.lineScoped = true

  if (res.binary) {
    addError(res, 'a line range was requested for a binary file, which has no lines; the file-level answer above stands')
    return
  }
  if (!res.existsInBench) {
    addError(res, `a line range was requested for ${res.path}, which does not exist in the assembled bench tree; the file-level answer above stands`)
    return
  }

  const blamed = blameRange(bench.benchPath, res.path, want)
  if (blamed.error !== undefined) {
    addError(res, `git blame failed for ${res.path} ${rangeString(want)}: ${blamed.error}`)
    ;(res.unknownLines ??= []).push(want)
    return
  }
  if (!blamed.lines || blamed.lines.length === 0) {
    addError(res, `git blame returned no lines for ${res.path} ${rangeString(want)}; the range may be past the end of the file`)
    ;(res.unknownLines ??= []).push(want)
    return
  }

  // One classification per DISTINCT commit: a 200-line range typically has a
  // handful of origins, and asking per line would run hundreds of identical
  // ancestry queries.
  const classifier = new CommitClassifier(bench)
  const perMember = new Map<string, number[]>()
  const commitsByMember = new Map<string, Set<string>>()
  const sourceLines: number[] = []
  const resolutionLines: number[] = []
  const unknownLines: number[] = []

  for (const bl of blamed.lines) {
    const cls = classifier.classify(bl.commit, res)
    switch (cls.kind) {
      case 'member': {
        const path = cls.worktreePath!
        let lines = perMember.get(path)
        if (!lines) perMember.set(path, (lines = []))
        lines.push(bl.line)
        let commits = commitsByMember.get(path)
        if (!commits) commitsByMember.set(path, (commits = new Set()))
        commits.add(bl.commit)
        break
      }
      case 'source':
        sourceLines.push(bl.line)
        break
      case 'resolution':
        resolutionLines.push(bl.line)
        break
      default:
        unknownLines.push(bl.line)
    }
  }

  // Attach matched lines to the candidates already gathered; a member blame
  // found but whose file-level diff did not name is appended, because blame is
  // the more precise instrument and dropping its answer would lose the owner.
  for (const [path, lines] of perMember) {
    let idx = res.candidates.findIndex((c) => c.worktreePath === path)
    if (idx < 0) {
      const cand = candidateFromBlame(bench, path)
      cand.status = CandidateChanged
      res.candidates.push(cand)
      idx = res.candidates.length - 1
      addWarning(res, `blame attributed lines in ${res.path} to member ${cand.branchName ?? ''} whose path-limited diff did not report the file (a rename or a mode change can do this); the blame answer is used.`)
    }
    res.candidates[idx].matchedLines = coalesce(lines)
    res.candidates[idx].commits = [...(commitsByMember.get(path) ?? [])].sort()
  }

  const source = coalesce(sourceLines)
  if (source.length > 0) res.sourceLines = source
  const resolution = coalesce(resolutionLines)
  if (resolution.length > 0) res.resolutionLines = resolution
  const unknown = coalesce(unknownLines)
  if (unknown.length > 0) (res.unknownLines ??= []).push(...unknown)

  if (res.resolutionLines && res.resolutionLines.length > 0) {
    addWarning(res, 'Some requested lines were produced by a conflict resolution recorded in an assembly merge commit. They are not verbatim from any single member, so editing one member may not reproduce them; the resolution itself is re-applied on each assembly.')
  }
}

/** Build a candidate for a member blame named but the file-level diff did not. */
function candidateFromBlame(bench: IntegrationWorkspace, worktreePath: string) {
  const m = bench.members.find((mm) => mm.worktreePath === worktreePath)
  if (m) return baseCandidate(m)
  return {
    worktreePath, enabled: true, status: 'unknown', stalenessKnown: false,
  }
}

// ── Outcome ──────────────────────────────────────────────────────────────────

/**
 * Map the gathered evidence onto exactly one outcome.
 *
 * The precedence is deliberate. A single member with no other origin is the
 * only case that yields a confident `member`; ANY mixture — two members, a
 * member plus source, a member plus an unreadable member — is `ambiguous`, so
 * a caller is never handed one owner for content that has more than one.
 * Nothing determined at all is `unknown`, never a fallback to the most likely
 * member.
 */
export function decideOutcome(res: AttributionResult): AttributionOutcome {
  let owners = 0
  let failed = 0
  for (const cand of res.candidates) {
    if (cand.error) {
      failed++
      continue
    }
    owners++
  }

  const unknownCount = res.unknownLines?.length ?? 0
  const sourceCount = res.sourceLines?.length ?? 0
  const resolutionCount = res.resolutionLines?.length ?? 0

  if (res.lineScoped) {
    let matched = 0
    for (const cand of res.candidates) {
      if (cand.matchedLines && cand.matchedLines.length > 0) matched++
    }
    if (unknownCount > 0 && matched === 0 && sourceCount === 0 && resolutionCount === 0) return 'unknown'
    if (matched > 1) return 'ambiguous'
    if (matched === 1) {
      if (sourceCount > 0 || resolutionCount > 0 || unknownCount > 0 || failed > 0) return 'ambiguous'
      return 'member'
    }
    if (resolutionCount > 0 && sourceCount > 0) return 'ambiguous'
    if (resolutionCount > 0) return failed > 0 ? 'ambiguous' : 'resolution'
    if (sourceCount > 0) return failed > 0 ? 'ambiguous' : 'source'
    return 'unknown'
  }

  if (owners > 1) return 'ambiguous'
  if (owners === 1) return failed > 0 ? 'ambiguous' : 'member'
  if (failed > 0) {
    // Every member that could have owned it failed to read. Naming source
    // here would be a confident answer built on nothing.
    return 'unknown'
  }
  return 'source'
}
