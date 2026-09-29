/**
 * Map the operator's worktree completion strategy onto land flags.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `worktreeCompletionStrategy` was honoured by exactly one caller (the old
 * "Finish work" flow) and ignored by the row-menu Land verb, which passed no
 * flags at all. So an operator who had set "Merge (ff)" got a plain merge —
 * fast-forward when possible, a merge commit when not — with nothing on screen
 * saying which had happened.
 *
 * Two things follow, and this module encodes both:
 *
 *   1. **A fast-forward strategy must sync first.** A land is only a
 *      fast-forward when the source branch is an ancestor of the worktree
 *      branch. The moment the source moves on, that stops being true and no
 *      flag can restore it — only rebasing the worktree onto the source tip
 *      can. So `merge-ff` implies `syncFirst`, otherwise the strategy is a
 *      promise the mechanism cannot keep.
 *   2. **It must refuse rather than substitute.** With `requireFastForward`
 *      the land uses `--ff-only`, so a diverged branch produces an actionable
 *      refusal instead of a silent merge commit.
 *
 * Kept in `shared/` because both the renderer (row menu, finish-work menu) and
 * any future consumer need the same answer; two copies of this mapping would
 * drift the way the original one-caller version did.
 */
import type { WorktreeCompletionStrategy } from './types'

/** The land flags implied by a completion strategy. */
export interface LandStrategyFlags {
  /** Rebase onto the source tip before integrating. */
  syncFirst: boolean
  /** Use `--ff-only`: refuse rather than write a merge commit. */
  requireFastForward: boolean
  /** Force a merge commit even when a fast-forward would do. */
  noFf: boolean
}

/**
 * Flags for `gitWorktreeLand`, derived from the operator's strategy.
 *
 * `pr` is not a land at all (it pushes and opens a compare URL), so it maps to
 * the same conservative shape as a plain merge; callers route it elsewhere
 * before reaching a land.
 */
export function landFlagsForStrategy(strategy: WorktreeCompletionStrategy): LandStrategyFlags {
  switch (strategy) {
    case 'merge-ff':
      // Linear history: rebase onto the source tip, then require the
      // fast-forward that rebase just made possible.
      return { syncFirst: true, requireFastForward: true, noFf: false }
    case 'merge':
      // An explicit merge commit is the point of this strategy, so there is
      // nothing to sync for and nothing to require.
      return { syncFirst: false, requireFastForward: false, noFf: true }
    case 'pr':
    default:
      return { syncFirst: false, requireFastForward: false, noFf: false }
  }
}

/**
 * One-line description of what a strategy will do, for menu labels and
 * confirmation copy.
 *
 * The old label said "Fast-forward into <branch>" while the code ran a plain
 * merge — the operator was told one thing and given another. These strings are
 * generated from the same switch that produces the flags so they cannot drift
 * from the behaviour again.
 */
export function describeLandStrategy(strategy: WorktreeCompletionStrategy, sourceBranch: string): string {
  switch (strategy) {
    case 'merge-ff':
      return `Sync from ${sourceBranch}, then fast-forward (no merge commit)`
    case 'merge':
      return `Merge into ${sourceBranch} with a merge commit`
    case 'pr':
      return `Push and open a pull request into ${sourceBranch}`
    default:
      return `Land into ${sourceBranch}`
  }
}
