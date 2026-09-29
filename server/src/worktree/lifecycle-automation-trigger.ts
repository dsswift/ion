import { warn as _warn } from '../logger'

const TAG = 'worktree.lifecycle_automation'
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export type WorktreeLifecycleAutomationEvent = 'worktree:created' | 'worktree:landed' | 'worktree:retired'

export interface WorktreeLifecycleAutomationTrigger {
  onWorktreeLifecycleEvent(type: WorktreeLifecycleAutomationEvent, payload: Record<string, unknown>): void | Promise<void>
}

let automationTrigger: WorktreeLifecycleAutomationTrigger | null = null

/** Register optional automation delivery for facts persisted by worktree lifecycle verbs. */
export function setWorktreeLifecycleAutomationTrigger(trigger: WorktreeLifecycleAutomationTrigger | null): () => void {
  automationTrigger = trigger
  return () => {
    if (automationTrigger === trigger) automationTrigger = null
  }
}

/** Deliver a durable worktree lifecycle fact after its registry mutation succeeds. */
export async function triggerWorktreeLifecycleAutomation(
  type: WorktreeLifecycleAutomationEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!automationTrigger) return
  try {
    await automationTrigger.onWorktreeLifecycleEvent(type, payload)
  } catch (err) {
    warn('automation lifecycle trigger failed', { event_type: type, ...payload, error: String(err) })
  }
}
