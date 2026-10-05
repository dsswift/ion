/**
 * usage-limit-format — how the Inbox and the composer word a usage limit and
 * a prompt the server is holding.
 */
import type { DeferredRelease } from '@ion/shared/usage-limit'

/** "3:40 PM" today, "Tue 3:40 PM" on another day. */
export function formatClock(ms: number, now: number = Date.now()): string {
  const at = new Date(ms)
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** What a row says about the prompt the server holds for it. */
export function heldPromptLabel(release: DeferredRelease, limitedUntil: number | null): string {
  if (release === 'spare-quota') return 'Queued for spare quota'
  return limitedUntil !== null ? `Resumes ${formatClock(limitedUntil)}` : 'Resumes at reset'
}
