/**
 * Bench resolution journal — what was decided about a conflicted file, and why.
 *
 * ── The gap this fills, and why `git rerere` cannot fill it ─────────────────
 * rerere already works and is already shared: recordings live in the main repo's
 * `$GIT_COMMON_DIR/rr-cache`, every linked worktree sees them, and this repo has
 * accumulated over a hundred. It still does not stop the same file conflicting
 * once per member, because rerere is keyed by the EXACT CONFLICT TEXT. Member A
 * against the source branch and member B against the source branch produce
 * different hunks in the same file, so the key differs and no recording matches.
 * Every assembly is `switch -C <bench> <source>` followed by a fresh merge per
 * member, so member B's collision is the first time that pairing has ever been
 * seen; and a failed assembly wipes the bench, so the tree the previous
 * resolution produced is not even on disk to consult.
 *
 * The measured cost of that: six bench merges in one hour, five of them
 * conflicting on the same file, each resolved from a cold start. The longest took
 * fifteen minutes, most of it spent reading that one file out of eight sibling
 * worktrees to reconstruct what an earlier conversation had already worked out.
 *
 * So this records the half rerere structurally cannot key — the REASONING — and
 * hands it to whoever resolves the same file next.
 *
 * ── Advisory, never applied ─────────────────────────────────────────────────
 * Nothing in the assembly path reads these entries to change a merge outcome.
 * They are context for an agent or an operator, exactly like a code comment: a
 * previous decision worth knowing about, not a resolution to replay. rerere
 * remains the only thing that replays a resolution, because a recording keyed by
 * conflict text is verifiable and a paragraph of prose is not.
 *
 * ── Pruning is by staleness, not by count ───────────────────────────────────
 * An entry whose `baseSha` is no longer an ancestor of the current source tip
 * describes a reconciliation against history that no longer exists. That is the
 * precise reason to drop it. A "keep the last N" cap would evict a still-valid
 * entry for a hot file while retaining dead ones — the same substitution of a
 * heuristic for a mechanism this codebase forbids elsewhere.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'
import { ionDir } from './bench-store'

const TAG = 'bench.journal'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Lazily resolved, never captured at module load — same rule as bench-store. */
export function resolutionsFile(): string {
  return join(ionDir(), 'integration-resolutions.json')
}

/**
 * One completed bench resolution.
 *
 * Every field is a fact recorded at the moment the resolution was PROVEN good
 * (postconditions checked, project verification passed). Nothing here is
 * inferred later.
 */
export interface BenchResolutionEntry {
  repoPath: string
  sourceBranch: string
  benchBranch: string
  /** Bench-relative path that was conflicted and resolved. */
  path: string
  /** The member being merged when the conflict arose. */
  memberBranch: string
  /**
   * Earlier members whose pinned ranges also touch this path — the counterparts
   * the resolution reconciled against. Makes the original pairing explicit, so a
   * later reader can judge how much of this decision transfers to their own.
   */
  collidedWith: string[]
  /** The bench base the resolution was made against. Drives staleness pruning. */
  baseSha: string
  /** The member contribution that was being merged. */
  memberPinnedSha: string
  /** The merge commit the completed resolution produced. */
  resolvedSha: string
  resolvedAt: number
  /** Whether project verification ran AND passed for this resolution. */
  verified: boolean
  /**
   * Why the resolution went the way it did, in the resolver's own words.
   *
   * Written by whoever resolved the conflict — the reasoning exists only in
   * their head, and deriving it from the diff would be a guess dressed as a
   * record. Empty when nothing was recorded: a partial hint beats none, and an
   * absent rationale must read as absent rather than be invented.
   */
  rationale: string
}

interface ResolutionsFile {
  version: 1
  entries: BenchResolutionEntry[]
}

/** Read the journal. A missing or corrupt file yields an empty one, logged. */
export function loadResolutions(): BenchResolutionEntry[] {
  return loadResolutionsDetailed().entries
}

/**
 * Read the journal and report its health alongside the entries.
 *
 * A missing file is the normal first-run state and carries no warning. A
 * corrupt or shape-less file yields no entries AND a warning string, because
 * an advisory reader (the BenchResolutionHistory tool) must tell its caller
 * that prior decisions exist but could not be read — silence there is
 * indistinguishable from an empty journal, and this is a state someone has to
 * fix. The single parse path for the journal lives here; `loadResolutions`
 * delegates so the two readers can never disagree about what the file holds.
 */
export function loadResolutionsDetailed(): { entries: BenchResolutionEntry[]; warning: string | null } {
  const file = resolutionsFile()
  if (!existsSync(file)) return { entries: [], warning: null }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ResolutionsFile
    if (!Array.isArray(parsed?.entries)) {
      warn('journal has no entries array, treating as empty', { file })
      return {
        entries: [],
        warning: `the resolution journal at ${file} is not readable JSON (no entries array), so no prior decisions are reported.`,
      }
    }
    return {
      entries: parsed.entries.filter((e) => e && typeof e.path === 'string' && !!e.repoPath),
      warning: null,
    }
  } catch (err) {
    // A hand-edited or truncated file must not break a bench merge. The journal
    // is advisory; losing it costs context, never work.
    warn('journal unreadable, treating as empty', { file, error: String(err) })
    return {
      entries: [],
      warning: `the resolution journal at ${file} is not readable JSON (${String(err)}), so no prior decisions are reported.`,
    }
  }
}

/**
 * Append one entry, dropping any whose base no longer exists in the source
 * history.
 *
 * `isCurrentBase` decides staleness. It is injected rather than called here so
 * this module stays free of a git dependency and so the caller — which already
 * holds an open repo and knows the current tip — answers it without a second
 * subprocess per entry. A base it cannot judge is KEPT: dropping an entry
 * because a probe failed would silently discard good context.
 */
export function recordResolution(
  entry: BenchResolutionEntry,
  isCurrentBase?: (baseSha: string) => boolean,
): void {
  const existing = loadResolutions()
  const kept = isCurrentBase
    ? existing.filter((e) => {
      if (e.repoPath !== entry.repoPath || e.sourceBranch !== entry.sourceBranch) return true
      try {
        return isCurrentBase(e.baseSha)
      } catch (err) {
        warn('staleness probe threw, keeping entry', { path: e.path, error: String(err) })
        return true
      }
    })
    : existing
  const pruned = existing.length - kept.length

  try {
    // `atomicWriteFileSync` opens the temp file directly and does not create the
    // directory, so the Ion home must exist first — on a fresh machine, or in a
    // fixture, the first bench resolution would otherwise be silently lost.
    // Same guard `saveWorkspaces` applies for the same reason.
    const dir = ionDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    atomicWriteFileSync(
      resolutionsFile(),
      JSON.stringify({ version: 1, entries: [...kept, entry] } satisfies ResolutionsFile, null, 2),
    )
    log('recorded bench resolution', {
      repo_path: entry.repoPath,
      source_branch: entry.sourceBranch,
      path: entry.path,
      member_branch: entry.memberBranch,
      collided_with: entry.collidedWith.join(','),
      resolved_sha: entry.resolvedSha.slice(0, 7),
      verified: entry.verified,
      has_rationale: entry.rationale.length > 0,
      pruned_stale: pruned,
    })
  } catch (err) {
    // The merge is already committed and valid at this point. Losing an advisory
    // hint is not worth failing it, so this degrades loudly rather than throwing.
    warn('could not write journal; resolution is committed but unrecorded', {
      repo_path: entry.repoPath, path: entry.path, error: String(err),
    })
  }
}

/**
 * Entries relevant to a bench, newest first, optionally narrowed to paths.
 *
 * Keyed by `(repoPath, sourceBranch)` and NOT by member: the whole point is that
 * a decision made while integrating one member is available when a different
 * member collides on the same file. `collidedWith` on each entry is what lets a
 * reader see which pairing the decision came from.
 */
export function resolutionsFor(
  repoPath: string,
  sourceBranch: string,
  paths?: readonly string[],
): BenchResolutionEntry[] {
  const wanted = paths && paths.length > 0 ? new Set(paths) : null
  return loadResolutions()
    .filter((e) => e.repoPath === repoPath && e.sourceBranch === sourceBranch)
    .filter((e) => !wanted || wanted.has(e.path))
    .sort((a, b) => b.resolvedAt - a.resolvedAt)
}
