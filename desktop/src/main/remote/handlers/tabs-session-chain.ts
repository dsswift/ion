/**
 * tabs-session-chain.ts
 *
 * Session-chain resolution + pure pagination for `desktop_load_conversation`.
 *
 * iOS history is served from the ENGINE (`load_session_history` over the
 * daemon socket) — the same source the overlay and ATV hydrate from — so all
 * clients render one canonical transcript. The renderer is consulted only for
 * tab METADATA (conversation id, historical session ids, runtime status);
 * no message content ever crosses the renderer seam. When the renderer is
 * unavailable (desktop restart, window closed), the persisted tabs file
 * supplies the same metadata, and the engine daemon — which outlives the
 * renderer — supplies the messages.
 */

import { existsSync, readFileSync } from 'fs'
import { log as _log } from '../../logger'
import { state } from '../../state'
import { TABS_FILE } from '../../settings-store'
import type { Message } from '../../../shared/types'
import type { RemoteMessage } from '../protocol-remote-tab'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export interface TabSessionChain {
  /** Engine session ids to load, in chain order (historical first). */
  sessionIds: string[]
  /** Renderer-reported runtime tab status ('running' | 'connecting' | ...). */
  tabStatus?: string
  /** The tab's current conversation id (last element of the chain). */
  conversationId: string | null
}

/**
 * Resolve the session-id chain for a tab: live renderer metadata first (it
 * tracks status and any not-yet-persisted chain growth), persisted tabs file
 * as the fallback when the renderer is unavailable.
 */
export async function resolveTabSessionChain(tabId: string): Promise<TabSessionChain | null> {
  const fromRenderer = await chainFromRenderer(tabId)
  if (fromRenderer) return fromRenderer

  const fromDisk = chainFromPersistedTabs(tabId)
  if (fromDisk) {
    log('load_conversation: session chain resolved from persisted tabs', { tab_id: tabId, sessions: fromDisk.sessionIds.length })
    return fromDisk
  }
  return null
}

/** Metadata-only renderer query: three scalars, no message content. */
async function chainFromRenderer(tabId: string): Promise<TabSessionChain | null> {
  if (!state.mainWindow) return null
  const escaped = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  try {
    const meta = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var tab = store.getState().tabs.find(function(t) { return t.id === '${escaped}'; });
          if (!tab) return null;
          return {
            conversationId: tab.conversationId || null,
            historicalSessionIds: tab.historicalSessionIds || [],
            status: tab.status || null,
          };
        } catch (e) { return null; }
      })()
    `)
    if (!meta) return null
    const ids: string[] = [...(meta.historicalSessionIds || [])]
    if (meta.conversationId) ids.push(meta.conversationId)
    if (ids.length === 0) return null
    return { sessionIds: ids, tabStatus: meta.status || undefined, conversationId: meta.conversationId }
  } catch (err) {
    log('load_conversation: renderer metadata query failed', { tab_id: tabId, error: (err as Error).message })
    return null
  }
}

/** Fallback: the persisted tabs file carries the same chain metadata. */
function chainFromPersistedTabs(tabId: string): TabSessionChain | null {
  try {
    if (!existsSync(TABS_FILE)) return null
    const data = JSON.parse(readFileSync(TABS_FILE, 'utf-8'))
    const tabs: any[] = Array.isArray(data?.tabs) ? data.tabs : []
    const tab = tabs.find((t) => t?.id === tabId)
    if (!tab) return null
    const ids: string[] = [...(tab.historicalSessionIds || [])]
    if (tab.conversationId) ids.push(tab.conversationId)
    if (ids.length === 0) return null
    return { sessionIds: ids, conversationId: tab.conversationId || null }
  } catch (err) {
    log('load_conversation: persisted tabs read failed', { tab_id: tabId, error: (err as Error).message })
    return null
  }
}

/**
 * Hard ceiling on messages in a single history page, applied AFTER the
 * turn-boundary snap. The snap walks backward to the start of a turn so iOS
 * never renders a partial turn — but a pathological single turn (e.g. a long
 * agent run with hundreds of tool messages) would otherwise produce a
 * multi-MB frame. Serializing/compressing/encrypting that on the main thread
 * is a relay wedge risk. When a turn exceeds this cap, the page starts
 * mid-turn and iOS paginates the remainder via hasMore — a bounded frame
 * beats a whole turn.
 */
export const MAX_PAGE_MESSAGES = 80

/** Default page size for `desktop_load_conversation`. */
export const PAGE_SIZE = 10

/** Maximum content chars carried per tool row over the wire. */
const TOOL_CONTENT_CAP = 2048

export interface HistoryPage {
  page: Message[]
  hasMore: boolean
  cursor?: string
  total: number
}

/**
 * Paginate a mapped transcript for the wire. Pure — unit-testable without
 * Electron. Cursor (`before`) is a message id; with canonical engine row ids
 * cursors stay valid across desktop restarts and repeated loads.
 *
 * Steps: resolve the window from the cursor, snap its start back to a user
 * turn boundary (never send a partial turn), re-cap to MAX_PAGE_MESSAGES
 * (give up turn alignment past the ceiling), and truncate oversized tool
 * content.
 */
export function paginateHistory(all: readonly Message[], before?: string, pageSize: number = PAGE_SIZE): HistoryPage {
  const total = all.length
  let endIdx = total
  let startIdx = Math.max(0, total - pageSize)

  if (before) {
    const cursorIdx = all.findIndex((m) => m.id === before)
    if (cursorIdx > 0) {
      endIdx = cursorIdx
      startIdx = Math.max(0, endIdx - pageSize)
    }
  }

  // Snap backward to a turn boundary (user message) to avoid partial turns.
  while (startIdx > 0 && all[startIdx] && all[startIdx].role !== 'user') {
    startIdx--
  }

  if (endIdx - startIdx > MAX_PAGE_MESSAGES) {
    startIdx = endIdx - MAX_PAGE_MESSAGES
  }

  const page = all.slice(startIdx, endIdx).map((m) => {
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > TOOL_CONTENT_CAP) {
      return { ...m, content: m.content.substring(0, TOOL_CONTENT_CAP) + '\n... [truncated]' }
    }
    return m
  })

  const hasMore = startIdx > 0
  return { page, hasMore, cursor: hasMore && page.length > 0 ? page[0].id : undefined, total }
}

/**
 * Project a mapped history `Message` onto the wire `RemoteMessage` shape.
 * History rows only ever carry the persisted roles (user / assistant / tool /
 * system) — renderer-local roles (thinking, harness, intercept) never come
 * out of the engine flatten, so the narrowing cast is safe and asserted here.
 */
export function toRemoteMessage(m: Message): RemoteMessage {
  return {
    id: m.id,
    role: (m.role === 'user' || m.role === 'assistant' || m.role === 'tool' ? m.role : 'system') as RemoteMessage['role'],
    content: m.content || '',
    toolName: m.toolName,
    toolInput: m.toolInput,
    toolId: m.toolId,
    toolStatus: m.toolStatus,
    timestamp: m.timestamp ?? 0,
    slashCommand: m.slashCommand,
    slashArgs: m.slashArgs,
    slashSource: m.slashSource,
    planFilePath: m.planFilePath,
    attachments: (m.attachments || []).map((a) => ({
      id: a.id,
      type: (a.type === 'image' || a.type === 'file' || a.type === 'plan' ? a.type : 'file') as 'image' | 'file' | 'plan',
      name: a.name,
      path: a.path ?? '',
    })),
  }
}

/**
 * Resolve a fallback plan file path for an ExitPlanMode row from the loaded
 * transcript itself: the most recent Write tool row targeting
 * ~/.ion/plans/*.md before falling back to nothing. Replaces the old
 * renderer-scrape IIFE — the engine rows carry the same information.
 */
export function planPathFromHistory(all: readonly Message[]): string | undefined {
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]
    if (m.role === 'tool' && m.toolName === 'Write' && m.toolInput) {
      try {
        const input = JSON.parse(m.toolInput)
        const fp = input.file_path
        if (typeof fp === 'string' && /\/\.ion\/plans\/[^/]+\.md$/.test(fp)) return fp
      } catch {
        // Not JSON tool input — skip.
      }
    }
  }
  return undefined
}
