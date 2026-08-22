/**
 * Attribution support layer — the types, path canonicalization, and git runner
 * shared by the bench attribution engine (bench-attribution.ts), the member
 * file reader (bench-member-file.ts), and the bench agent tools.
 *
 * Ported from the engine's Go implementation (engine/internal/workspaces:
 * attribution.go, attribution_git.go, paths.go) as these read-only tools move
 * from the engine to the desktop as client tools. The JSON field names below
 * are the model-facing contract and mirror the Go structs' tags exactly.
 *
 * ── Why canonicalization is load-bearing here ────────────────────────────────
 * Every rule in this module family is a comparison between a path and a root.
 * A comparison between two spellings of the same path is not a comparison at
 * all. On macOS this is the DEFAULT rather than an exotic case: /tmp is a
 * symlink to /private/tmp and /var to /private/var, so a recorded bench path
 * and a resolved cwd routinely disagree with no user involvement. So both
 * sides are canonicalized before any containment question is asked: made
 * absolute, lexically cleaned, and symlink-resolved as deeply as the
 * filesystem allows.
 *
 * Canonicalization NEVER refuses on its own. A path that cannot be resolved
 * (nonexistent parents) falls back to its lexically-cleaned absolute form.
 * Rejection is a separate, explicit decision made by the caller.
 */
import { execFileSync } from 'child_process'
import { lstatSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'path'
import type { IntegrationMember, IntegrationWorkspace } from '../../shared/types'
import { lookupWorktreeTitle } from '../worktree/registry'
import { loadWorkspaces } from './bench-store'

/**
 * AttributionOutcome is the verdict for one attribution request. Exhaustive
 * and explicit: there is no "probably" state.
 *
 * - `member` — exactly one member owns the requested content.
 * - `ambiguous` — more than one origin contributes; candidates lists every one.
 * - `source` — no member changed this content; it comes from the
 *   bench's source branch.
 * - `resolution` — the content exists because a conflict resolution was
 *   recorded in an assembly merge commit, so it is not verbatim from any
 *   single member. Editing a member may not reproduce it.
 * - `unknown` — attribution could not be completed. Never a silent fallback
 *   to a plausible owner.
 */
export type AttributionOutcome = 'member' | 'ambiguous' | 'source' | 'resolution' | 'unknown'

/** AttributionRequest asks who owns a path, optionally narrowed to lines. */
export interface AttributionRequest {
  /** Any path inside the bench; the bench is resolved from it. */
  benchPath: string
  /** The file in question, absolute or bench-relative. */
  path: string
  /** 1-based, inclusive. Zero startLine means the whole file. */
  startLine?: number
  endLine?: number
}

/** LineRange is an inclusive 1-based line span. JSON: {start, end}. */
export interface LineRange {
  start: number
  end: number
}

export function rangeString(r: LineRange): string {
  return r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`
}

/**
 * Candidate statuses describe what a member's pinned contribution did to the
 * file. Strings rather than an enum so an unrecognized future git status can
 * be reported verbatim instead of collapsing into a wrong known value.
 */
export const CandidateChanged = 'changed'
export const CandidateAdded = 'added'
export const CandidateDeleted = 'deleted'
export const CandidateRenamed = 'renamed'
export const CandidateUnknown = 'unknown'

/**
 * AttributionCandidate is one possible origin of the requested content, with
 * everything a caller needs to choose between candidates itself. Optional
 * fields mirror the Go struct's `omitempty` tags: absent when empty, so the
 * serialized JSON matches the engine's output shape.
 */
export interface AttributionCandidate {
  worktreePath: string
  branchName?: string
  title?: string
  /** The pinned contribution range identifies this member's Bench content. */
  pinnedRange?: string
  pinnedSha?: string
  pinnedBaseSha?: string
  /** What the pinned contribution did to this file. */
  status: string
  /** Previous path when status is renamed — the path to edit may differ. */
  renamedFrom?: string
  /** True when git reports the change as binary; no line ranges exist. */
  binary?: boolean
  /** Line spans this member changed, in the MEMBER's coordinates. Complete. */
  changedRanges?: LineRange[]
  /**
   * Requested lines this member owns in the ASSEMBLED tree, established by
   * blame. Populated only for a line-scoped request; it is the precise answer.
   */
  matchedLines?: LineRange[]
  /** Member commits blame attributed the matched lines to. */
  commits?: string[]
  /** True when the member worktree has moved past its pin. */
  stale?: boolean
  stalenessKnown: boolean
  pin?: string
  merge?: string
  /**
   * Set when this member's contribution could not be read. The candidate is
   * still listed: dropping it would be indistinguishable from a member that
   * does not own the file.
   */
  error?: string
}

/**
 * AttributionResult is the complete JSON-ready answer. Nothing here is
 * truncated or summarized: a caller that wants a short answer can shorten it,
 * but a caller given a truncated answer cannot recover the rest.
 */
export interface AttributionResult {
  outcome: AttributionOutcome
  benchPath: string
  benchBranch?: string
  repoPath?: string
  sourceBranch?: string
  baseSha?: string
  /** Bench-relative path attribution ran against. */
  path: string
  /** Absolute symlink-resolved form it was derived from. */
  canonicalPath?: string
  /** Echo of the validated line scope, absent for a whole-file question. */
  requestedLines?: LineRange
  /** Whether the answer used blame (precise, shift-aware) or file diffing. */
  lineScoped: boolean
  /** Every possible owner, ordered by merge order. */
  candidates: AttributionCandidate[]
  /**
   * Requested lines that came from the source branch / exist only because of
   * an assembly merge's conflict resolution / could not be classified. All
   * reported alongside member candidates so a mixed range is legible.
   */
  sourceLines?: LineRange[]
  resolutionLines?: LineRange[]
  unknownLines?: LineRange[]
  binary?: boolean
  deletedInBench?: boolean
  existsInBench: boolean
  /** Facts that change how the answer should be read. Never an outcome. */
  warnings?: string[]
  /**
   * Git or record failures encountered while answering. Non-empty with a
   * non-unknown outcome means the answer is partial: what is reported is
   * real, but a member may be missing detail.
   */
  errors?: string[]
  /**
   * Set when the request itself was refused (not a bench, path outside the
   * bench, traversal, unresolvable line range). Outcome is unknown then.
   */
  rejection?: string
}

export function addWarning(res: { warnings?: string[] }, w: string): void {
  (res.warnings ??= []).push(w)
}
export function addError(res: { errors?: string[] }, e: string): void {
  (res.errors ??= []).push(e)
}

// ── Git runner ────────────────────────────────────────────────────────────────

/**
 * The outcome of one git invocation. `error` folds in the first stderr line:
 * a bare "exit status 128" is unactionable, and the whole point of surfacing
 * git errors is that the model can read what git objected to. `code` is kept
 * because `git merge-base --is-ancestor` communicates its ANSWER through exit
 * code 1, and distinguishing that from a real failure (128: missing object) is
 * what keeps a legitimate "no" from being reported as a git error.
 */
export interface GitOutcome {
  out: string
  error: string | null
  code: number
}
export type GitRunner = (dir: string, args: string[]) => GitOutcome

export const realGitRunner: GitRunner = (dir, args) => {
  try {
    const out = execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { out, error: null, code: 0 }
  } catch (err) {
    const e = err as { status?: number | null; stdout?: unknown; stderr?: unknown; message?: string }
    const code = typeof e.status === 'number' ? e.status : -1
    const detail = firstLine(String(e.stderr ?? '').trim())
    const error = detail
      ? `exit status ${code}: ${detail}`
      : `exit status ${code}: ${e.message ?? 'git failed'}`
    return { out: String(e.stdout ?? ''), error, code }
  }
}

let gitOverride: GitRunner | null = null

/**
 * Swap the git runner attribution uses, so a test can assert error surfacing
 * without arranging a broken repository. Pass null to restore the real one.
 */
export function setAttributionGitForTest(runner: GitRunner | null): void {
  gitOverride = runner
}

/** Run git in a directory, honoring the test override. */
export function attrGit(dir: string, args: string[]): GitOutcome {
  return (gitOverride ?? realGitRunner)(dir, args)
}

export function firstLine(s: string): string {
  const i = s.indexOf('\n')
  return i >= 0 ? s.slice(0, i).trim() : s
}

export function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha
}

export function nonEmptyLines(value: string): string[] {
  return value.split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

export function splitNul(out: string): string[] {
  return out.split('\0').map((f) => f.trim()).filter((f) => f !== '')
}

export function splitFields(s: string): string[] {
  return s.split(/[\s]+/).filter((f) => f !== '')
}

// ── Path canonicalization and containment ───────────────────────────────────

export type PathRejection =
  | 'empty_path'
  | 'not_absolute'
  | 'traversal_escapes_root'
  | 'outside_root'
  | 'nul_byte'

/**
 * Absolute, lexically clean, symlink-resolved form of a path.
 *
 * Resolution walks from the deepest EXISTING ancestor: a target need not
 * exist, and realpath on a nonexistent leaf fails outright, which would leave
 * two spellings disagreeing for the same directory. Resolving the existing
 * prefix and re-joining the missing tail gives one answer for both.
 */
export function canonicalizePath(p: string): string {
  if (!p) return ''
  if (!isAbsolute(p)) {
    // A relative path has no meaning without a base; the caller resolves
    // against the bench first. Clean it so the value is at least stable.
    return normalize(p)
  }
  const abs = normalize(p)
  try {
    return normalize(realpathSync(abs))
  } catch {
    // Walk up to the deepest existing ancestor, resolve, re-join the tail.
  }
  let remainder = ''
  let current = abs
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return abs
    remainder = remainder ? join(basename(current), remainder) : basename(current)
    current = parent
    let resolved: string
    try {
      resolved = realpathSync(current)
    } catch {
      continue
    }
    return normalize(join(resolved, remainder))
  }
}

/**
 * True when path is root or a descendant of it. The separator is REQUIRED on
 * the descendant check: a bare startsWith would also match a sibling whose
 * name merely begins with the root (…/ion-a33725460 against …/ion-a3372546).
 */
export function isWithin(path: string, root: string): boolean {
  if (!path || !root) return false
  if (path === root) return true
  return path.startsWith(root + sep)
}

/** Compare a canonical path against a record root, canonicalizing the root. */
export function withinRoot(canonicalPath: string, root: string): boolean {
  if (!canonicalPath || !root) return false
  // Compare against the cleaned raw root too: a root that cannot be resolved
  // (a bench whose directory was removed) still has to answer.
  return isWithin(canonicalPath, canonicalizePath(root)) || isWithin(canonicalPath, normalize(root))
}

/** A `..` PATH SEGMENT, checked per segment so `notes..txt` is not a traversal. */
export function hasDotDotSegment(path: string): boolean {
  return path.split(sep).some((s) => s === '..') || path.split('/').some((s) => s === '..')
}

/**
 * Join a base and a relative path WITHOUT cleaning, so `..` segments survive
 * for resolveWithin to classify. path.join would clean them away — which is
 * exactly the evidence needed to tell a traversal from a plain outside path.
 */
export function joinRaw(base: string, rel: string): string {
  return base ? base + sep + rel : rel
}

/**
 * Canonicalize target against root and return the bench-relative path when
 * target is a descendant. This is the single gate for "is this file inside
 * this bench". It rejects rather than fails open: callers are read-only
 * attribution and classification, where an out-of-root path is a caller error
 * with a real answer, not a guard that might over-refuse someone's work.
 *
 * target must be the caller's RAW spelling: cleaning erases the `..` segments
 * that distinguish a traversal from a plainly external path.
 */
export function resolveWithin(
  target: string,
  root: string,
): { rel: string; canonical: string; rejection: PathRejection | '' } {
  if (!target) return { rel: '', canonical: '', rejection: 'empty_path' }
  if (target.includes('\0')) return { rel: '', canonical: '', rejection: 'nul_byte' }
  if (!isAbsolute(target)) return { rel: '', canonical: '', rejection: 'not_absolute' }
  const hadTraversal = hasDotDotSegment(target)
  const canonical = canonicalizePath(target)
  const canonicalRoot = canonicalizePath(root)
  if (!canonicalRoot) return { rel: '', canonical, rejection: 'outside_root' }
  if (!isWithin(canonical, canonicalRoot)) {
    return { rel: '', canonical, rejection: hadTraversal ? 'traversal_escapes_root' : 'outside_root' }
  }
  const rel = relative(canonicalRoot, canonical)
  if (!rel || rel === '.') {
    // The root itself is a directory, never an attributable file.
    return { rel: '', canonical, rejection: 'outside_root' }
  }
  return { rel: rel.split(sep).join('/'), canonical, rejection: '' }
}

/** Present on disk — tells a deleted file (attributable) from a bad path. */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// ── Bench and member record helpers ─────────────────────────────────────────

/** The bench workspace containing path, or null. Reads the live record. */
export function benchForPath(path: string): IntegrationWorkspace | null {
  if (!path) return null
  const canonical = canonicalizePath(path)
  for (const ws of loadWorkspaces()) {
    if (withinRoot(canonical, ws.benchPath)) return ws
  }
  return null
}

/**
 * Whether the member's current work differs from what the bench holds. Only
 * answerable when BOTH tree hashes are recorded: an absent hash is unknown,
 * and unknown must not read as "current" — that would assert freshness the
 * record does not carry.
 */
export function memberStale(m: IntegrationMember): boolean {
  if (!m.pinnedTreeHash || !m.currentTreeHash) return false
  return m.pinnedTreeHash !== m.currentTreeHash
}

export function memberStalenessKnown(m: IntegrationMember): boolean {
  return !!m.pinnedTreeHash && !!m.currentTreeHash
}

/** The contribution range in git syntax, or "" when unrecorded. */
export function memberPinnedRange(m: IntegrationMember): string {
  if (!m.pinnedBaseSha || !m.pinnedSha) return ''
  return `${m.pinnedBaseSha}..${m.pinnedSha}`
}

/**
 * Whether the member has committed nothing of its own. An equal base/tip pair
 * is the one fact no git query at assembly time can recover once the source
 * branch moves, so it is read from the record.
 */
export function memberEmptyContribution(m: IntegrationMember): boolean {
  return !!m.pinnedBaseSha && m.pinnedBaseSha === m.pinnedSha
}

/**
 * A candidate seeded from a member record, before any git question is asked.
 * The worktree TITLE is joined from the registry: a redirect that names only a
 * path and a branch makes the caller guess which piece of work it is being
 * sent into. The title is decoration, never a precondition — a member with no
 * registry entry still attributes.
 */
export function baseCandidate(m: IntegrationMember): AttributionCandidate {
  const cand: AttributionCandidate = {
    worktreePath: m.worktreePath,
    status: CandidateUnknown,
    stalenessKnown: memberStalenessKnown(m),
  }
  if (m.branchName) cand.branchName = m.branchName
  const title = lookupWorktreeTitle(m.worktreePath)
  if (title) cand.title = title
  const range = memberPinnedRange(m)
  if (range) cand.pinnedRange = range
  if (m.pinnedSha) cand.pinnedSha = m.pinnedSha
  if (m.pinnedBaseSha) cand.pinnedBaseSha = m.pinnedBaseSha
  if (memberStale(m)) cand.stale = true
  if (m.pin) cand.pin = m.pin
  if (m.merge) cand.merge = m.merge
  return cand
}

// ── Line-range set helpers ───────────────────────────────────────────────────

/** Order spans by start so a reported set is stable regardless of blame order. */
export function sortRanges(ranges: LineRange[]): LineRange[] {
  return ranges.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end))
}

/**
 * Merge adjacent and overlapping spans, so 12 consecutive owned lines read as
 * L10-21 rather than twelve single-line entries.
 */
export function coalesce(lines: number[]): LineRange[] {
  if (lines.length === 0) return []
  lines.sort((a, b) => a - b)
  const out: LineRange[] = []
  let cur: LineRange = { start: lines[0], end: lines[0] }
  for (const n of lines.slice(1)) {
    if (n === cur.end || n === cur.end + 1) {
      cur.end = n
      continue
    }
    out.push(cur)
    cur = { start: n, end: n }
  }
  out.push(cur)
  return out
}
