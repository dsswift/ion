/**
 * A conversation selection Studio painted before the local owner confirmed it.
 *
 * Selecting a conversation shows it at once and forwards `selectTab` to the
 * owning server. While the window sits on a local conversation, every local
 * tabs push names the owner's active tab, and the hydration follows it. A
 * push the owner published before it handled the selection still names the
 * old conversation, so following it jumped the window back, and the
 * selection only showed again when a push published after it arrived.
 *
 * The selection is held until the local owner settles it: a push that names
 * it, or, once the owner has answered the action, any push newer than every
 * push received before that answer.
 */
import { rDebug } from '../../rendererLogger'

interface Pending {
  tabId: string
  /** The newest local revision received when the owner answered; null until it does. */
  answeredAfterRevision: number | null
}

let pending: Pending | null = null
let newestLocalRevisionReceived = -1

/** Record the revision of a local tabs push as it arrives, before any coalescing. */
export function noteLocalTabsRevisionReceived(revision: unknown): void {
  if (typeof revision === 'number' && revision > newestLocalRevisionReceived) newestLocalRevisionReceived = revision
}

/** Studio painted `tabId` as selected and forwarded the selection to the local owner. */
export function beginPendingSelection(tabId: string): void {
  pending = { tabId, answeredAfterRevision: null }
}

/** The local owner answered the selection of `tabId`. */
export function answerPendingSelection(tabId: string): void {
  if (pending?.tabId === tabId) pending = { tabId, answeredAfterRevision: newestLocalRevisionReceived }
}

/** The selection of `tabId` failed and was rolled back. */
export function dropPendingSelection(tabId: string): void {
  if (pending?.tabId === tabId) pending = null
}

/**
 * Whether a local push must leave the window's selection alone. Settles and
 * clears the pending selection when this push resolves it.
 */
export function holdsSelectionAgainst(ownerActiveTabId: string | null, revision: unknown): boolean {
  if (!pending) return false
  if (ownerActiveTabId === pending.tabId) {
    pending = null
    return false
  }
  const answeredAfter = pending.answeredAfterRevision
  if (answeredAfter !== null && typeof revision === 'number' && revision > answeredAfter) {
    rDebug('studio.mirror', 'pending selection released: owner answered and moved on', { tab_id: pending.tabId, owner_active_tab_id: ownerActiveTabId ?? '' })
    pending = null
    return false
  }
  rDebug('studio.mirror', 'pending selection held against an older owner push', { tab_id: pending.tabId, owner_active_tab_id: ownerActiveTabId ?? '', revision: typeof revision === 'number' ? revision : -1 })
  return true
}

/** TEST ONLY. */
export function _resetPendingSelectionForTest(): void {
  pending = null
  newestLocalRevisionReceived = -1
}
