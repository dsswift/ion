/**
 * Worktree close appraisal — what happens when a worktree conversation closes.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 * `closeTab` called `gitWorktreeRemove(..., force = true)` unconditionally, and
 * the remove handler followed with `git branch -D`. Closing a worktree tab
 * therefore destroyed uncommitted changes AND made unlanded commits
 * unreachable, with no prompt and no recovery. An accidental tab close — a
 * stray Cmd+W — silently deleted work.
 *
 * ── The rule now ───────────────────────────────────────────────────────────
 * **Closing a conversation never removes a worktree.** The two are separate
 * lifetimes: a conversation is a thread of discussion, a worktree is a place
 * work lives. Removing a worktree is its own explicit verb (retire), gated by
 * its own appraisal.
 *
 * This makes close cheap and reversible, so it does not need to be forbidden.
 * Forbidding it would pin the operator to one immortal conversation per
 * worktree; instead the worktree remains, and the worktree inventory offers a
 * one-click path back into it with a fresh conversation.
 *
 * A close still WARNS when the worktree holds work that is not in the feature
 * branch. Not to prevent the close — nothing is lost — but because "you are
 * walking away from 4 unlanded commits" is information the operator wants at
 * that moment, and the appraisal already knows it.
 */
import type { WorktreeAppraisal } from './safety'

/** What the UI should do when a worktree conversation is closing. */
export interface CloseWorktreeDecision {
  /**
   * Whether to remove the worktree. ALWAYS false: closing a conversation is
   * not a request to destroy a working directory. Present as an explicit field
   * (rather than an absence) so the invariant is visible and testable.
   */
  removeWorktree: false
  /** True when the operator should be told what is being left behind. */
  shouldWarn: boolean
  /** One-line summary of what remains in the worktree. */
  summary?: string
  /** Where the work will still be, so the warning is reassuring, not alarming. */
  worktreePath: string
}

/**
 * Decide how to close a worktree conversation.
 *
 * Pure: takes an appraisal, returns a decision. No git, no side effects, so it
 * is trivially testable and cannot itself destroy anything.
 *
 * `appraisal` may be null when the appraisal could not be completed. That is
 * NOT treated as "nothing to warn about" — an unknown state warns, because the
 * cost of a needless warning is a click and the cost of a missed one is the
 * operator walking away from work they did not know was there.
 */
export function decideWorktreeClose(
  worktreePath: string,
  appraisal: WorktreeAppraisal | null,
): CloseWorktreeDecision {
  if (!appraisal || appraisal.appraisalFailed) {
    return {
      removeWorktree: false,
      shouldWarn: true,
      summary: 'This worktree still exists, and its contents could not be verified.',
      worktreePath,
    }
  }

  if (appraisal.safeToDiscard) {
    // Everything is committed and landed: closing is uneventful.
    return { removeWorktree: false, shouldWarn: false, worktreePath }
  }

  const parts: string[] = []
  if (appraisal.hasUncommittedChanges) {
    const n = appraisal.uncommittedPaths.length
    parts.push(`${n} uncommitted file${n === 1 ? '' : 's'}`)
  }
  if (!appraisal.fullyLanded) {
    const n = appraisal.unlandedCommitCount
    parts.push(`${n} commit${n === 1 ? '' : 's'} not yet landed`)
  }

  return {
    removeWorktree: false,
    shouldWarn: true,
    summary: `This worktree keeps ${parts.join(' and ')}. Nothing is deleted — reopen it any time from the Worktrees list.`,
    worktreePath,
  }
}
