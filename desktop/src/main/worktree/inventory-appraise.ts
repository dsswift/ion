/**
 * Sha-keyed appraisal cache for the worktree inventory crawl.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The inventory used to answer "how far ahead / behind is this worktree, and
 * would a sync change it?" by running `appraiseWorktree` + `appraiseBase` per
 * worktree per crawl — five to six git subprocesses each, every 5 seconds,
 * for every listed worktree. With 25 worktrees that is ~150 spawns per crawl,
 * and overlapping crawls saturated the main process event loop with
 * posix_spawn until the overlay froze.
 *
 * Every one of those answers is a pure function of exactly two refs: the
 * worktree's HEAD sha and the source branch's tip sha. Neither count nor tree
 * comparison can change unless one of the shas moves. So the cache is
 * content-addressed by the (HEAD, tip) pair — a precise mechanism, not a
 * staleness heuristic: a hit is *proven* current by the shas, and any commit,
 * land, or sync on either side changes a sha and misses.
 *
 * On a miss the pair costs ONE spawn (`rev-list --left-right --count`), plus
 * one more (`rev-parse` of both tree ids) only when the worktree is behind.
 * Dirty state is deliberately NOT here: uncommitted changes have no sha, so
 * `git status` stays a per-crawl probe in the inventory.
 */
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.appraise'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** The land-relative facts derivable from a (HEAD, source-tip) ref pair. */
export interface RefPairAppraisal {
  /** Commits on HEAD not reachable from the source tip — what `branch -D` would orphan. */
  ahead: number
  /** Commits on the source tip not reachable from HEAD. */
  behind: number
  /**
   * True when the two commits' TREES differ — i.e. a sync would actually
   * change this worktree's content. False when being "behind" is bookkeeping
   * (its own work just landed). Same conjunction `appraiseBase` computes.
   */
  treesDiffer: boolean
}

interface CacheEntry {
  headSha: string
  sourceTipSha: string
  appraisal: RefPairAppraisal
}

/** Keyed by worktree path; validated against the sha pair on every read. */
const pairCache = new Map<string, CacheEntry>()

/**
 * Commit subjects keyed by sha — a subject can never change under its sha.
 * Insertion-ordered Map used as a simple LRU bound.
 */
const subjectCache = new Map<string, string>()
const SUBJECT_CACHE_MAX = 500

/**
 * Per-crawl hit/miss tally. Owned by the CALLER (one per crawl) rather than a
 * module global, so two crawls of different repos running concurrently cannot
 * blend each other's numbers into a log line that lies.
 */
export interface AppraisalCounters { hits: number; misses: number }

/**
 * Appraise a worktree against its source branch tip, cached by the sha pair.
 *
 * Returns null when git could not answer (unreachable sha, corrupt checkout).
 * Callers must treat null as "unknown" and fail closed on safety decisions —
 * the same contract as `appraiseWorktree`'s `appraisalFailed`. Failures are
 * never cached: the next crawl retries.
 */
export async function appraiseRefPair(
  worktreePath: string,
  headSha: string,
  sourceTipSha: string,
  counters?: AppraisalCounters,
): Promise<RefPairAppraisal | null> {
  const cached = pairCache.get(worktreePath)
  if (cached && cached.headSha === headSha && cached.sourceTipSha === sourceTipSha) {
    if (counters) counters.hits++
    return cached.appraisal
  }
  if (counters) counters.misses++

  let ahead = 0
  let behind = 0
  try {
    // One spawn for both directions: left = only in source tip (behind),
    // right = only in HEAD (ahead / unlanded).
    const raw = await runGit(worktreePath, [
      'rev-list', '--left-right', '--count', `${sourceTipSha}...${headSha}`,
    ])
    const [left, right] = raw.trim().split(/\s+/).map((n) => parseInt(n, 10))
    if (Number.isNaN(left) || Number.isNaN(right)) {
      warn('unparseable rev-list count', { worktree_path: worktreePath, raw: raw.trim() })
      return null
    }
    behind = left
    ahead = right
  } catch (err) {
    warn('ref-pair appraisal failed', {
      worktree_path: worktreePath,
      head: headSha.slice(0, 7),
      source_tip: sourceTipSha.slice(0, 7),
      error: String(err),
    })
    return null
  }

  // The tree comparison only matters when behind — an up-to-date or ahead-only
  // worktree never shows the sync badge, so spend the second spawn only when
  // the answer can be consulted.
  let treesDiffer = false
  if (behind > 0) {
    try {
      const raw = await runGit(worktreePath, [
        'rev-parse', `${headSha}^{tree}`, `${sourceTipSha}^{tree}`,
      ])
      const [headTree, tipTree] = raw.trim().split('\n').map((s) => s.trim())
      treesDiffer = !!headTree && !!tipTree && headTree !== tipTree
    } catch (err) {
      warn('tree comparison failed', { worktree_path: worktreePath, error: String(err) })
      return null
    }
  }

  const appraisal: RefPairAppraisal = { ahead, behind, treesDiffer }
  pairCache.set(worktreePath, { headSha, sourceTipSha, appraisal })
  log('appraised ref pair', {
    worktree_path: worktreePath,
    head: headSha.slice(0, 7),
    source_tip: sourceTipSha.slice(0, 7),
    ahead,
    behind,
    trees_differ: treesDiffer,
  })
  return appraisal
}

/**
 * The subject of `sha`'s commit, cached forever under the sha.
 * Empty string when unreadable (matches the inventory's previous degradation).
 */
export async function commitSubject(worktreePath: string, sha: string): Promise<string> {
  const cached = subjectCache.get(sha)
  if (cached !== undefined) return cached
  let subject = ''
  try {
    subject = (await runGit(worktreePath, ['log', '-1', '--format=%s', sha])).trim()
  } catch (err) {
    log('could not read commit subject', { worktree_path: worktreePath, sha: sha.slice(0, 7), error: String(err) })
    return ''
  }
  subjectCache.set(sha, subject)
  if (subjectCache.size > SUBJECT_CACHE_MAX) {
    const oldest = subjectCache.keys().next().value
    if (oldest !== undefined) subjectCache.delete(oldest)
  }
  return subject
}

/**
 * Drop pair-cache entries for worktrees that no longer exist, so a retired
 * path cannot pin stale state. Called by the inventory after each listing.
 */
export function pruneAppraisalCache(livePaths: Set<string>): void {
  for (const path of pairCache.keys()) {
    if (!livePaths.has(path)) pairCache.delete(path)
  }
}

export function _resetAppraisalCacheForTests(): void {
  pairCache.clear()
  subjectCache.clear()
}
