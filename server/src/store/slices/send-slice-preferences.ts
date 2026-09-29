/**
 * Refresh a conversation's Personal-preferences stamp from the client that is
 * sending it a prompt (conversation-preferences.ts). Split from send-slice.ts,
 * which is at the file-size cap.
 *
 * A machine-sent prompt (an automation, a schedule) runs outside any client
 * request, carries no preferences, and leaves the stamp as it was: the
 * conversation keeps running under what its last human sender chose.
 */
import type { StoreSet, StoreGet } from '../session-store-types'
import { restamp } from '../../conversation-preferences'
import { rDebug } from '../rendererLogger'

export function restampConversationPreferences(set: StoreSet, get: StoreGet, tabId: string): void {
  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab) return
  const next = restamp(tab.conversationPreferences)
  if (next === tab.conversationPreferences) return
  set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, conversationPreferences: next } : t)) }))
  rDebug('submit', 'conversation preferences restamped from the sending client', { tab_id: tabId.slice(0, 8), keys: Object.keys(next ?? {}) })
}
