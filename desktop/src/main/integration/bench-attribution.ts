/**
 * Read-only attribution: which member worktree owns a file — or a specific
 * range of lines — in an assembled integration bench.
 *
 * Ported from engine/internal/workspaces/attribution.go + attribution_git.go
 * as the WorkspaceAttribution tool moves from the Go engine to the desktop as
 * a client tool. The JSON output shape is identical to the engine's, so the
 * model-facing answer does not change with the move.
 *
 * ── The question this answers, and why precision matters ────────────────────
 * A build fails in a bench. The failing file is assembled from a source branch
 * plus every enabled member's pinned contribution, and the bench itself is not
 * writable — so the only actionable answer is "this belongs to member X, edit
 * it there". Getting that wrong sends an edit to the wrong worktree, where it
 * is either irrelevant or actively harmful.
 *
 * The naive answer, "who last touched this file", is confidently wrong exactly
 * when it matters: whenever two members change one file, whenever a member's
 * tip commit touches a different file than the commit that introduced the
 * problem, and whenever a line moved because an earlier member's hunk shifted
 * it. So attribution asks the question the assembly actually asked:
 *
 *   - Per FILE: does the member's pinned RANGE (`pinnedBaseSha..pinnedSha`)
 *     touch this path? The range, never the tip.
 *   - Per LINE: blame the assembled tree, then decide for each blamed commit
 *     whether it lies inside some member's pinned range, in the bench's base
 *     history, or in an assembly merge commit. Blame is what makes this exact
 *     under line shifts: it reports the commit that produced the line as it
 *     exists NOW, so a hunk pushed down by an earlier member is still
 *     attributed to its real author.
 *
 * ── Why it never guesses one owner ──────────────────────────────────────────
 * Every outcome is explicit and every candidate is reported. Two members
 * touching one file is `ambiguous` with both listed and their exact changed
 * ranges, not a coin flip. Content that exists only because a conflict
 * resolution was recorded in an assembly merge commit is `resolution`, not
 * silently credited to whichever side won. A git failure is `unknown` with the
 * error surfaced — a member whose diff could not be read is still LISTED, with
 * its error, because a silently omitted member is indistinguishable from a
 * member that genuinely does not own the file, and that is the one failure mode
 * that produces a wrong redirect with full confidence.
 *
 * ── Read-only, and why that is structural ───────────────────────────────────
 * Nothing here writes. Every git invocation is a query (blame, diff, rev-list,
 * cat-file, merge-base), the bench is never modified, and the records are never
 * written. That is what makes it safe to expose to a model in plan mode.
 */
import { isAbsolute } from 'path'
import type { IntegrationMember, IntegrationWorkspace } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import {
  type AttributionCandidate, type AttributionRequest, type AttributionResult, type LineRange,
  CandidateAdded, CandidateChanged, CandidateDeleted, CandidateRenamed, CandidateUnknown,
  addError, addWarning, attrGit, baseCandidate, benchForPath, canonicalizePath, joinRaw,
  memberEmptyContribution, memberStale, memberStalenessKnown,
  nonEmptyLines, pathExists, resolveWithin, sortRanges, splitNul,
} from './bench-attribution-support'
import { attributeLines, decideOutcome } from './bench-attribution-lines'

const TAG = 'bench.attribution'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Attribute answers one attribution request. It never writes, never mutates
 * the records, and never throws: every failure is expressed in the result
 * (rejection, errors, outcome unknown) so a consumer gets one shape to render
 * and a model gets an actionable message instead of a stack trace.
 */
export function attribute(req: AttributionRequest): AttributionResult {
  const res: AttributionResult = {
    outcome: 'unknown', benchPath: '', path: req.path, lineScoped: false,
    candidates: [], existsInBench: false,
  }

  const bench = benchForPath(canonicalizePath(req.benchPath))
  if (!bench) {
    res.rejection = `${req.benchPath} is not inside a registered integration bench, so there is nothing to attribute against`
    logAttribution(res, req)
    return res
  }
  res.benchPath = bench.benchPath
  if (bench.benchBranch) res.benchBranch = bench.benchBranch
  if (bench.repoPath) res.repoPath = bench.repoPath
  if (bench.sourceBranch) res.sourceBranch = bench.sourceBranch
  if (bench.baseSha) res.baseSha = bench.baseSha

  const resolved = resolveRequestPath(req.path, bench)
  if (resolved.rejection) {
    res.rejection = resolved.rejection
    logAttribution(res, req)
    return res
  }
  res.path = resolved.rel
  if (resolved.canonical) res.canonicalPath = resolved.canonical

  const lineScope = validateLineRange(req)
  if (lineScope.rejection) {
    res.rejection = lineScope.rejection
    logAttribution(res, req)
    return res
  }
  if (lineScope.lines) res.requestedLines = lineScope.lines

  // Bench-level facts that make every later answer interpretable.
  for (const w of benchWarnings(bench)) addWarning(res, w)
  if (!bench.baseSha) {
    addWarning(res, 'The bench record carries no baseSha, so a member with no recorded pinnedBaseSha has no contribution range to diff and source-branch ancestry cannot be confirmed.')
  }

  describeBenchFile(bench, res)
  collectCandidates(bench, res)

  if (lineScope.lines) {
    attributeLines(bench, lineScope.lines, res)
  }

  res.outcome = decideOutcome(res)
  logAttribution(res, req)
  return res
}

/**
 * Turn the requested path into a bench-relative path, rejecting anything that
 * is not genuinely inside the bench. Symlinks are resolved on both sides
 * first: on macOS the recorded bench path and a resolved cwd routinely differ
 * by /private, and a raw string comparison would reject legitimate paths as
 * outside. Shared with the member-file and resolution-history tools.
 */
export function resolveRequestPath(
  path: string,
  bench: IntegrationWorkspace,
): { rel: string; canonical: string; rejection: string } {
  let target = path
  if (!target) return { rel: '', canonical: '', rejection: 'no path was given to attribute' }
  if (target.includes('\0')) {
    return { rel: '', canonical: '', rejection: 'the path contains a NUL byte and cannot name a file' }
  }
  if (!isAbsolute(target)) {
    // Joined WITHOUT cleaning so a `..` segment survives to be classified as
    // a traversal rather than silently normalized into a plain outside path.
    target = joinRaw(bench.benchPath, target)
  }

  const { rel, canonical, rejection } = resolveWithin(target, bench.benchPath)
  switch (rejection) {
    case '':
      return { rel, canonical, rejection: '' }
    case 'traversal_escapes_root':
      return { rel: '', canonical, rejection: `${path} resolves to ${canonical}, which escapes the bench ${bench.benchPath}; attribution answers only about files inside the bench` }
    case 'outside_root':
      return { rel: '', canonical, rejection: `${path} resolves to ${canonical}, which is outside the bench ${bench.benchPath}; attribution answers only about files inside the bench` }
    case 'not_absolute':
      return { rel: '', canonical, rejection: `${path} could not be resolved to an absolute path inside the bench ${bench.benchPath}` }
    default:
      return { rel: '', canonical, rejection: `${path} is not a usable path (${rejection})` }
  }
}

/**
 * Normalize the 1-based inclusive line request. An invalid range is REJECTED
 * rather than silently widened to the whole file: a caller asking about lines
 * 40-30 has a bug, and answering about the entire file would look like a
 * successful answer to the question they think they asked.
 */
function validateLineRange(req: AttributionRequest): { lines?: LineRange; rejection?: string } {
  const startLine = req.startLine ?? 0
  const endLine = req.endLine ?? 0
  if (startLine === 0 && endLine === 0) return {}
  if (startLine === 0 && endLine !== 0) {
    return { rejection: `endLine ${endLine} was given without a startLine; give both or neither` }
  }
  if (startLine < 0 || endLine < 0) {
    return { rejection: 'line numbers are 1-based and cannot be negative' }
  }
  const end = endLine === 0 ? startLine : endLine
  if (end < startLine) {
    return { rejection: `endLine ${endLine} is before startLine ${startLine}` }
  }
  return { lines: { start: startLine, end } }
}

/**
 * emptyTreeSha is git's well-known empty tree object, used to diff a path
 * against nothing so an unchanged file still produces a numstat row.
 */
const emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Record what the file IS in the assembled tree: present or deleted, text or
 * binary. A line-scoped question about a binary file has no answer, and a
 * question about a path deleted in the bench is still answerable from history
 * — both need stating rather than being discovered as a confusing empty
 * result.
 */
function describeBenchFile(bench: IntegrationWorkspace, res: AttributionResult): void {
  const absolute = `${bench.benchPath}/${res.path}`
  res.existsInBench = pathExists(absolute)

  if (!res.existsInBench) {
    // Distinguish "tracked but deleted in the assembled tree" from "never
    // existed": the first is attributable from history, the second is a bad
    // path the caller should know about.
    const del = attrGit(bench.benchPath, ['log', '-1', '--format=%H', '--diff-filter=D', '--', res.path])
    if (del.error) {
      addError(res, `could not determine whether ${res.path} was deleted in the bench: ${del.error}`)
    } else if (del.out.trim() !== '') {
      res.deletedInBench = true
      addWarning(res, `${res.path} does not exist in the assembled bench tree; it was deleted in bench history. Attribution below is derived from the recorded contributions, not from the current tree.`)
    } else {
      addWarning(res, `${res.path} does not exist in the assembled bench tree and no bench commit deleted it, so it may never have been part of this assembly.`)
    }
    return
  }

  // `--numstat` reports `-\t-` for a binary path. Asked against the empty
  // tree so a file with no bench-history change still answers.
  const numstat = attrGit(bench.benchPath, ['diff', '--numstat', '--no-renames', emptyTreeSha, 'HEAD', '--', res.path])
  if (numstat.error) {
    addError(res, `could not determine whether ${res.path} is binary: ${numstat.error}`)
    return
  }
  for (const line of nonEmptyLines(numstat.out)) {
    if (line.startsWith('-\t-\t')) {
      res.binary = true
      addWarning(res, `${res.path} is a binary file: no line-level attribution exists for it, so ownership is reported per file only.`)
      break
    }
  }
}

/**
 * Ask each enabled member whether its PINNED RANGE touches the file, and
 * record what it did to it.
 *
 * A member whose diff cannot be read is appended WITH its error rather than
 * skipped. That is the difference between "this member does not own the file"
 * and "we could not tell", and collapsing the two is exactly how attribution
 * produces a wrong redirect with full confidence.
 */
function collectCandidates(bench: IntegrationWorkspace, res: AttributionResult): void {
  for (const m of bench.members) {
    const { cand, touches } = memberCandidate(bench, m, res)
    if (!touches) continue
    if (m.enabled) {
      res.candidates.push(cand)
    } else {
      (res.disabledMembersTouching ??= []).push(cand)
    }
  }

  if (res.disabledMembersTouching && res.disabledMembersTouching.length > 0) {
    const names = res.disabledMembersTouching.map((d) => d.branchName).join(', ')
    addWarning(res, `Disabled member(s) ${names} also change this file, but they are excluded from the assembly and own none of the bench's content.`)
  }
}

/**
 * Build one candidate. `touches` reports whether the member's contribution is
 * relevant at all — false means it genuinely does not touch the file AND
 * nothing failed while determining that.
 */
function memberCandidate(
  bench: IntegrationWorkspace,
  m: IntegrationMember,
  res: AttributionResult,
): { cand: AttributionCandidate; touches: boolean } {
  const cand = baseCandidate(m)

  if (!m.pinnedSha) {
    cand.error = 'the member has no pinnedSha recorded, so its contribution cannot be diffed'
    addError(res, `member ${m.branchName}: ${cand.error}`)
    return { cand, touches: true }
  }
  let base = m.pinnedBaseSha
  if (!base) {
    base = bench.baseSha
    if (!base) {
      cand.error = "neither the member's pinnedBaseSha nor the bench's baseSha is recorded, so the contribution range is unknown"
      addError(res, `member ${m.branchName}: ${cand.error}`)
      return { cand, touches: true }
    }
    cand.pinnedBaseSha = base
    cand.pinnedRange = `${base}..${m.pinnedSha}`
  }

  // `--find-renames` so a file the member renamed is attributed, and the
  // caller learns the path to edit in the worktree differs from the assembled
  // one. `-z` avoids quoting surprises on non-ASCII paths.
  const diff = attrGit(bench.benchPath, ['diff', '--name-status', '--find-renames', '-z', base, m.pinnedSha, '--', res.path])
  if (diff.error) {
    cand.error = `git could not read this member's contribution: ${diff.error}`
    addError(res, `member ${m.branchName}: ${cand.error}`)
    return { cand, touches: true }
  }
  const parsed = parseNameStatusZ(diff.out, res.path)
  const touches = parsed.touches
  let { status, renamedFrom } = parsed
  if (!touches || status === CandidateAdded) {
    // Rename detection needs a diff that can SEE both paths. A path-limited
    // diff excludes the rename source, so git has nothing to pair the
    // destination with and reports a plain Add — which would send the caller
    // to a file that does not exist in the member worktree under that name.
    // So an Add is re-checked against the unlimited diff, and a genuine
    // addition simply finds no rename and keeps its status.
    const rename = detectRenameInto(bench, base, m.pinnedSha, res.path)
    if (rename) {
      status = CandidateRenamed
      renamedFrom = rename.from
    } else if (!touches) {
      return { cand, touches: false }
    }
  }
  cand.status = status
  if (renamedFrom) cand.renamedFrom = renamedFrom

  fillCandidateRanges(bench, base, m.pinnedSha, res, cand)
  return { cand, touches: true }
}

/**
 * Find a rename whose DESTINATION is the requested path. A path-limited diff
 * can miss it, because git records the change against the source path when
 * the limit excludes it.
 */
function detectRenameInto(
  bench: IntegrationWorkspace, base: string, sha: string, rel: string,
): { from: string } | null {
  const out = attrGit(bench.benchPath, ['diff', '--name-status', '--find-renames', '--diff-filter=R', '-z', base, sha])
  if (out.error) return null
  const fields = splitNul(out.out)
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i].startsWith('R')) continue
    if (i + 2 >= fields.length) break
    const from = fields[i + 1]
    const to = fields[i + 2]
    i += 2
    if (to === rel) return { from }
  }
  return null
}

/**
 * Record the line spans the member changed and whether the change is binary.
 * A deleted or binary path has no line ranges, and saying so is the answer
 * rather than an empty list that reads like "no changes".
 */
function fillCandidateRanges(
  bench: IntegrationWorkspace, base: string, sha: string,
  res: AttributionResult, cand: AttributionCandidate,
): void {
  const numstat = attrGit(bench.benchPath, ['diff', '--numstat', '--find-renames', base, sha, '--', res.path])
  if (!numstat.error) {
    for (const line of nonEmptyLines(numstat.out)) {
      if (line.startsWith('-\t-\t')) {
        cand.binary = true
        break
      }
    }
  } else {
    addError(res, `member ${cand.branchName}: could not determine binary status: ${numstat.error}`)
  }
  if (cand.binary || cand.status === CandidateDeleted) return

  const diff = attrGit(bench.benchPath, ['diff', '-U0', '--find-renames', base, sha, '--', res.path])
  if (diff.error) {
    addError(res, `member ${cand.branchName}: could not read changed line ranges: ${diff.error}`)
    return
  }
  const ranges = sortRanges(parseHunkRanges(diff.out))
  if (ranges.length > 0) cand.changedRanges = ranges
}

/**
 * Read a NUL-separated --name-status stream and report what happened to rel.
 */
export function parseNameStatusZ(
  out: string, rel: string,
): { status: string; renamedFrom: string; touches: boolean } {
  const none = { status: '', renamedFrom: '', touches: false }
  const fields = splitNul(out)
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]
    if (code === '') continue
    if (code.startsWith('R') || code.startsWith('C')) {
      if (i + 2 >= fields.length) return none
      const from = fields[i + 1]
      const to = fields[i + 2]
      i += 2
      if (to === rel || from === rel) return { status: CandidateRenamed, renamedFrom: from, touches: true }
    } else {
      if (i + 1 >= fields.length) return none
      const path = fields[i + 1]
      i++
      if (path !== rel) continue
      switch (code[0]) {
        case 'A': return { status: CandidateAdded, renamedFrom: '', touches: true }
        case 'D': return { status: CandidateDeleted, renamedFrom: '', touches: true }
        case 'M':
        case 'T': return { status: CandidateChanged, renamedFrom: '', touches: true }
        default: return { status: CandidateUnknown, renamedFrom: '', touches: true }
      }
    }
  }
  return none
}

const hunkRangeRe = /^@@+ .*?\+(\d+)(?:,(\d+))? @@/

/**
 * Read `-U0` hunk headers into line spans in the NEW file's coordinates. A
 * zero-length hunk (`+12,0`) is a pure deletion at that point; it is reported
 * as the single adjacent line so the span is never empty.
 */
export function parseHunkRanges(diff: string): LineRange[] {
  const out: LineRange[] = []
  for (const line of diff.split('\n')) {
    const m = hunkRangeRe.exec(line)
    if (!m) continue
    const start = parseInt(m[1], 10)
    if (Number.isNaN(start)) continue
    let count = 1
    if (m[2] !== undefined) {
      const n = parseInt(m[2], 10)
      if (!Number.isNaN(n)) count = n
    }
    if (count === 0) {
      out.push({ start, end: start })
      continue
    }
    out.push({ start, end: start + count - 1 })
  }
  return out
}

/**
 * Bench-level facts that change how any attribution answer should be read:
 * a failed or unknown assembly, stale or unknowable pins, prior conflicts,
 * replayed resolutions, and empty contributions. Ported from the engine's
 * prompt-context benchWarnings so the moved tool reports the same facts.
 */
function benchWarnings(bench: IntegrationWorkspace): string[] {
  const warnings: string[] = []

  if (bench.lastAssembly === 'failed') {
    let w = 'The last assembly FAILED, so this bench was wiped to an empty tree and holds no member content. Anything built or tested here is not the enrolled combination.'
    if (bench.lastAssemblyError) w += ' Recorded error: ' + bench.lastAssemblyError
    warnings.push(w)
  } else if (!bench.lastAssembly) {
    warnings.push('The last assembly outcome is unknown for this bench (the record predates outcome tracking), so whether the tree matches the enrolled combination cannot be confirmed from the record.')
  }

  const stale: string[] = []
  const unknownStale: string[] = []
  for (const m of bench.members) {
    if (!m.enabled) continue
    if (memberStale(m)) stale.push(m.branchName)
    else if (!memberStalenessKnown(m)) unknownStale.push(m.branchName)
  }
  if (stale.length > 0) {
    warnings.push(`Pinned contributions are behind their worktrees for: ${stale.join(', ')}. The bench holds the PINNED work, not the current work in those worktrees.`)
  }
  if (unknownStale.length > 0) {
    warnings.push(`Pin freshness is unknown for: ${unknownStale.join(', ')} (the record carries no tree hashes to compare).`)
  }

  for (const m of bench.members) {
    if (!m.enabled) continue
    if (m.merge === 'conflicted') {
      let w = `Member ${m.branchName} last merged with CONFLICTS`
      if (m.conflictsWith && m.conflictsWith.length > 0) w += ' against ' + m.conflictsWith.join(', ')
      if (m.conflictPaths && m.conflictPaths.length > 0) w += ' in ' + m.conflictPaths.join(', ')
      warnings.push(w + '.')
    }
    if (m.mergeResolution === 'replayed') {
      warnings.push(`Member ${m.branchName} merged only because a recorded conflict resolution was replayed; that is deterministic but not the same fact as a clean merge.`)
    }
    if (memberEmptyContribution(m)) {
      warnings.push(`Member ${m.branchName} contributes nothing: its pinned range is empty, so it has committed no work of its own.`)
    }
  }
  return warnings
}

function logAttribution(res: AttributionResult, req: AttributionRequest): void {
  const fields: Record<string, unknown> = {
    bench_path: res.benchPath,
    path: res.path,
    outcome: res.outcome,
    line_scoped: res.lineScoped,
    candidates: res.candidates.length,
  }
  if ((req.startLine ?? 0) > 0) {
    fields.start_line = req.startLine
    fields.end_line = req.endLine
  }
  if (res.rejection) {
    fields.rejection = res.rejection
    warn('bench attribution rejected', fields)
    return
  }
  if (res.errors && res.errors.length > 0) fields.errors = res.errors
  if (res.warnings && res.warnings.length > 0) fields.warning_count = res.warnings.length
  log('bench attribution resolved', fields)
}
