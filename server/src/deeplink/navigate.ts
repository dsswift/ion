/**
 * Resolve a navigation link (`conversation`, `settings`, `file`) against the
 * server's state. A navigation link runs nothing, so it needs no
 * confirmation; it only has to name something that exists. The client that
 * opened the link moves its own view to the resolved target.
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { SETTINGS_TAXONOMY, SERVERS_PAGE_ID } from '@ion/shared/settings-taxonomy'
import type { DeepLinkNavigateTarget } from '@ion/shared/types-ipc-deeplink'
import { log as _log, warn as _warn } from '../logger'
import { projectablePages } from '../projectable-settings'
import { resolveConversationsDirSync } from '../conversation/principal-paths'
import { principalSubjectForConversation } from '../protocol/tabs-index'
import { useSessionStore } from '../store/sessionStore'
import type { DeepLinkNavPayload } from './parse'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export type NavigationResult = { ok: true; target: DeepLinkNavigateTarget } | { ok: false; reason: string }

/**
 * The tab showing `conversationId`. A conversation that exists on disk but is
 * not open is resumed into a new tab. Null when no such conversation exists.
 */
export async function tabForConversation(conversationId: string): Promise<string | null> {
  const open = useSessionStore.getState().tabs.find((t) => t.conversationId === conversationId)
  if (open) return open.id
  const dir = resolveConversationsDirSync(principalSubjectForConversation(conversationId))
  if (!existsSync(join(dir, `${conversationId}.tree.jsonl`))) {
    log('conversation link names no conversation', { conversation_id: conversationId })
    return null
  }
  const tabId = await useSessionStore.getState().resumeSession(conversationId)
  log('conversation link resumed a closed conversation', { conversation_id: conversationId, tab_id: tabId })
  return tabId || null
}

/** Whether `conversationId` is open in a tab or saved on disk, without opening it. */
export function conversationExists(conversationId: string): boolean {
  if (useSessionStore.getState().tabs.some((t) => t.conversationId === conversationId)) return true
  const dir = resolveConversationsDirSync(principalSubjectForConversation(conversationId))
  return existsSync(join(dir, `${conversationId}.tree.jsonl`))
}

function resolveSettings(panel: string): NavigationResult {
  if (panel === SERVERS_PAGE_ID) {
    return { ok: true, target: { route: 'settings', panel, pageId: SERVERS_PAGE_ID, projectable: false } }
  }
  const page = SETTINGS_TAXONOMY.find((p) => p.id === panel || p.sections.some((s) => s.id === panel))
  if (!page) return { ok: false, reason: `unknown settings panel ${panel}` }
  const projectable = projectablePages().some((p) => p.id === page.id)
  return { ok: true, target: { route: 'settings', panel, pageId: page.id, projectable } }
}

function resolveFile(dir: string, path: string): NavigationResult {
  if (!isAbsolute(dir)) return { ok: false, reason: 'file link dir must be absolute' }
  const full = resolve(dir, path)
  const rel = relative(dir, full)
  // `..` at the front, or an absolute result, means the path left `dir`.
  if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: 'file link path is outside its dir' }
  try {
    if (!statSync(full).isFile()) return { ok: false, reason: 'file link does not name a file' }
  } catch {
    return { ok: false, reason: 'file link names a file that does not exist' }
  }
  return { ok: true, target: { route: 'file', dir, path: full } }
}

export async function resolveNavigation(payload: DeepLinkNavPayload): Promise<NavigationResult> {
  let result: NavigationResult
  if (payload.action === 'conversation') {
    const tabId = await tabForConversation(payload.id)
    result = tabId
      ? { ok: true, target: { route: 'conversation', conversationId: payload.id, tabId } }
      : { ok: false, reason: 'unknown conversation' }
  } else if (payload.action === 'settings') {
    result = resolveSettings(payload.panel)
  } else {
    result = resolveFile(payload.dir, payload.path)
  }
  if (result.ok) log('navigation link resolved', { route: result.target.route })
  else warn('navigation link refused', { action: payload.action, reason: result.reason })
  return result
}
