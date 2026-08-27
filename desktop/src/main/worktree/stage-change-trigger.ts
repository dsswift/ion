import { warn as _warn } from '../logger'
import type { WorkStage } from '../../shared/types-git'

const TAG = 'worktree.stage_change'
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface WorktreeStageChange {
  worktreePath: string
  previousStage?: WorkStage
  stage?: WorkStage
  source: 'operator' | 'automation'
  automationId?: string
  causation?: import('../../shared/types-automation').AutomationCausation
}

export interface WorktreeStageChangeAutomationTrigger {
  onWorktreeStageChange(change: WorktreeStageChange): void | Promise<void>
}

let automationTrigger: WorktreeStageChangeAutomationTrigger | null = null

/** Register semantic stage-change delivery without coupling registry persistence to automation. */
export function setWorktreeStageChangeAutomationTrigger(
  trigger: WorktreeStageChangeAutomationTrigger | null,
): () => void {
  automationTrigger = trigger
  return () => {
    if (automationTrigger === trigger) automationTrigger = null
  }
}

/** Notify runtime only after durable stage persistence succeeded. */
export function triggerWorktreeStageChange(change: WorktreeStageChange): void {
  if (!automationTrigger) return
  Promise.resolve(automationTrigger.onWorktreeStageChange(change)).catch((err) => {
    warn('automation stage-change trigger failed', {
      worktree_path: change.worktreePath,
      stage: change.stage ?? 'none',
      source: change.source,
      error: String(err),
    })
  })
}
