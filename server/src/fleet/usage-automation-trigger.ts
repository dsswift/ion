import { warn as _warn } from '../logger'

const TAG = 'fleet.usage_automation'
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Usage facts an automation can react to: a conversation stopped by its
 * account's limit, that limit resetting, and an account about to reset with
 * quota unused.
 */
export type UsageAutomationEvent = 'usage:limit-reached' | 'usage:limit-reset' | 'usage:quota-expiring'

export interface UsageAutomationTrigger {
  onUsageEvent(type: UsageAutomationEvent, payload: Record<string, unknown>): void | Promise<void>
}

let automationTrigger: UsageAutomationTrigger | null = null

/** Register optional automation delivery for usage facts. */
export function setUsageAutomationTrigger(trigger: UsageAutomationTrigger | null): () => void {
  automationTrigger = trigger
  return () => {
    if (automationTrigger === trigger) automationTrigger = null
  }
}

export async function triggerUsageAutomation(type: UsageAutomationEvent, payload: Record<string, unknown>): Promise<void> {
  if (!automationTrigger) return
  try {
    await automationTrigger.onUsageEvent(type, payload)
  } catch (err) {
    warn('automation usage trigger failed', { event_type: type, ...payload, error: String(err) })
  }
}
