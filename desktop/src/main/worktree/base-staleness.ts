/**
 * Base staleness — has the branch a worktree was cut FROM moved on?
 *
 * ── Two independent directions of staleness ─────────────────────────────────
 * The system has two staleness signals and they point opposite ways. Conflating
 * them would make both meaningless, so they are computed and reported
 * separately:
 *
 *   1. **Bench staleness** (bench-store: `pinnedTreeHash` vs `currentTreeHash`)
 *      — the WORKTREE moved ahead of what the bench integrated. The operator
 *      resolves it by pressing Update on the member, which re-pins and rebuilds
 *      the bench. Direction: worktree -> bench.
 *
 *   2. **Base staleness** (this module) — the FEATURE BRANCH moved ahead of
 *      where the worktree was cut from. The operator resolves it by syncing the
 *      worktree, which rebases it onto the current feature tip. Direction:
 *      feature branch -> worktree.
 *
 * Base staleness happens constantly in the parallel workflow: every time
 * another worktree lands, the feature branch advances and every OTHER worktree
 * is now developing against stale code. It also happens when a teammate pushes
 * to the feature branch, or when the operator commits to it directly outside
 * any worktree. Developing against a stale base means writing code that
 * compiles locally and conflicts on land — the bench would silently paper over
 * it, which is exactly what the operator asked not to rely on.
 *
 * ── Why the commit count alone is not the signal ────────────────────────────
 * `git rev-list --count HEAD..<feature>` is the obvious measure and it
 * over-reports. Right after a worktree's own work lands, the feature branch
 * contains the land commit, so the worktree reads as "1 behind" while a sync
 * would gain it nothing — its content is already identical to the base. A badge
 * that a sync cannot clear is a lie, and the operator learns to ignore it.
 *
 * So the signal is: behind by at least one commit AND the sync would actually
 * change this worktree's content. `needsSync` carries that conjunction;
 * `behindCount` is kept for display.
 */
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.base'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface BaseStaleness {
  /** Commits on the source branch that this worktree does not have. */
  behindCount: number
  /** Subjects of those commits (capped, newest first) for display. */
  behindSubjects: string[]
  /**
   * True when the worktree is behind AND syncing would change its content.
   * This is the signal to surface — never `behindCount > 0` alone.
   */
  needsSync: boolean
  /** Uncommitted work present, so a rebase would be refused by git. */
  hasUncommittedChanges: boolean
  /** Set when the appraisal could not be completed (fails quiet, not stale). */
  appraisalFailed?: boolean
}

const DISPLAY_CAP = 20

/**
 * Determine whether a worktree is developing against a stale base.
 *
 * Read-only. On failure it reports `needsSync: false` with `appraisalFailed`
 * set: unlike the discard appraisal (which fails CLOSED because the cost of
 * being wrong is destroyed work), a false "you're stale" badge is noise, so
 * this one fails QUIET and stays silent when it cannot tell.
 */
export async function appraiseBase(worktreePath: string, sourceBranch: string): Promise<BaseStaleness> {
  const unknown: BaseStaleness = {
    behindCount: 0,
    behindSubjects: [],
    needsSync: false,
    hasUncommittedChanges: false,
    appraisalFailed: true,
  }

  let behindSubjects: string[]
  try {
    const raw = await runGit(worktreePath, ['log', '--format=%s', `HEAD..${sourceBranch}`])
    behindSubjects = raw.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (err) {
    warn('base appraisal failed reading behind list', { worktree_path: worktreePath, source_branch: sourceBranch, error: String(err) })
    return unknown
  }

  let hasUncommittedChanges = false
  try {
    const status = await runGit(worktreePath, ['status', '--porcelain'])
    hasUncommittedChanges = status.trim().length > 0
  } catch (err) {
    warn('base appraisal failed reading status', { worktree_path: worktreePath, error: String(err) })
    return unknown
  }

  // Would a sync actually change anything here? If the worktree's tree already
  // matches the source branch, being "behind" is bookkeeping (its own work just
  // landed) and there is nothing to gain.
  let contentWouldChange = behindSubjects.length > 0
  if (behindSubjects.length > 0) {
    try {
      await runGit(worktreePath, ['diff', '--quiet', sourceBranch, 'HEAD'])
      // Exit zero: trees identical, so a sync gains nothing.
      contentWouldChange = false
    } catch {
      // Non-zero: trees differ, so the sync is meaningful.
      contentWouldChange = true
    }
  }

  const result: BaseStaleness = {
    behindCount: behindSubjects.length,
    behindSubjects: behindSubjects.slice(0, DISPLAY_CAP),
    needsSync: behindSubjects.length > 0 && contentWouldChange,
    hasUncommittedChanges,
  }
  log('appraised base', {
    worktree_path: worktreePath,
    source_branch: sourceBranch,
    behind: result.behindCount,
    needs_sync: result.needsSync,
    dirty: hasUncommittedChanges,
  })
  return result
}
