/**
 * Whether a connection's principal owns a tab or a conversation. Every action
 * that names one checks here before it runs (ADR-034), whichever door the
 * action came through.
 */
import type { Connection } from './connection'
import { tabOwnedBySubject, principalSubjectForConversation } from './tabs-index'
import { unownedTabsVisible, isSharedTenancy } from '../config/current'

export function connOwnsTab(conn: Connection, tabId: string): boolean {
  return tabOwnedBySubject(tabId, conn.principal?.subject ?? null)
}

export function connOwnsConversation(conn: Connection, conversationId: string): boolean {
  if (isSharedTenancy()) return true
  const owner = principalSubjectForConversation(conversationId)
  if (!owner) return unownedTabsVisible()
  return conn.principal !== null && owner === conn.principal.subject
}
