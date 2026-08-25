/**
 * Semantic bridge from bench pinning into optional desktop automation.
 *
 * A pin advance says only that a worktree's newer committed content became part
 * of a bench. It does not prescribe a workflow stage. An automation runtime can
 * register one trigger and decide how to react. Until such a runtime exists,
 * the narrowly-scoped migration preserves the stage behavior older desktop
 * versions exposed.
 */
import type { WorktreePinAdvance } from '../../shared/types-git'
import { warn as _warn } from '../logger'
import { migrateWorktreeStageOnPinAdvance } from './registry'

const TAG = 'worktree.pin_advance'
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface WorktreePinAdvanceAutomationTrigger {
  onWorktreePinAdvance(advance: WorktreePinAdvance): void | Promise<void>
}

let automationTrigger: WorktreePinAdvanceAutomationTrigger | null = null

/**
 * Install optional automation runtime trigger. Returned cleanup only clears its
 * own registration, so an older runtime teardown cannot remove a newer one.
 */
export function setWorktreePinAdvanceAutomationTrigger(
  trigger: WorktreePinAdvanceAutomationTrigger | null,
): () => void {
  automationTrigger = trigger
  return () => {
    if (automationTrigger === trigger) automationTrigger = null
  }
}

/** Deliver a semantic pin-advance fact, or run rollout migration without runtime. */
export async function triggerWorktreePinAdvance(advance: WorktreePinAdvance): Promise<void> {
  if (!automationTrigger) {
    if (!migrateWorktreeStageOnPinAdvance(advance.worktreePath)) {
      warn('pin advance stage migration persist failed', { worktree_path: advance.worktreePath })
    }
    return
  }

  try {
    await automationTrigger.onWorktreePinAdvance(advance)
  } catch (err) {
    warn('automation pin advance trigger failed', {
      worktree_path: advance.worktreePath,
      branch: advance.branchName,
      error: String(err),
    })
  }
}
