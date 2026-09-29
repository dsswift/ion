import { warn as _warn } from '../logger'

const TAG = 'integration.bench_automation'
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface BenchAutomationTrigger {
  onBenchEvent(type: string, payload: Record<string, unknown>): void | Promise<void>
}

let automationTrigger: BenchAutomationTrigger | null = null

/** Register bench facts after their workspace mutation has persisted. */
export function setBenchAutomationTrigger(trigger: BenchAutomationTrigger | null): () => void {
  automationTrigger = trigger
  return () => {
    if (automationTrigger === trigger) automationTrigger = null
  }
}

export async function triggerBenchAutomation(type: string, payload: Record<string, unknown>): Promise<void> {
  if (!automationTrigger) return
  try {
    await automationTrigger.onBenchEvent(type, payload)
  } catch (err) {
    warn('automation trigger failed', { event_type: type, ...payload, error: String(err) })
  }
}
