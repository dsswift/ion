/**
 * push-title -- the conversation title a push may show.
 *
 * A push's text passes through the relay and Apple's push service in plain
 * text, so what it may say is this server's decision: the Environment setting
 * `pushConversationTitles` (on by default). On, a push names its
 * conversation, so two pushes at once read differently. Off, it carries only
 * generic text. Either way a push never carries anything beyond the title.
 */
import { readSettings } from '../persistence/settings-store'
import { debug as _debug } from '../logger'

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('thin-view', msg, fields)
}

/** Longest title a push shows; the lock screen truncates well before this. */
const MAX_TITLE = 80

/** Whether this server lets pushes name their conversation. */
export function pushTitlesEnabled(): boolean {
  return readSettings().pushConversationTitles !== false
}

/**
 * The title to show for a conversation, or null when this server keeps titles
 * out of pushes or the conversation has none yet. Callers fall back to their
 * generic text on null.
 */
export function pushConversationTitle(tab: { id: string; title?: string; customTitle?: string | null } | undefined): string | null {
  if (!tab) return null
  if (!pushTitlesEnabled()) {
    debug('push title withheld: setting off', { tab_id: tab.id.slice(0, 8) })
    return null
  }
  const title = (tab.customTitle || tab.title || '').replace(/\s+/g, ' ').trim()
  if (!title) return null
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title
}
