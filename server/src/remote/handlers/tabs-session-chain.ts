import { existsSync, readFileSync } from 'fs'
import { state } from '../../state'
import { tabsFile } from '../../persistence/settings-store'
import { log as _log } from '../../logger'
import { orderedSessionIds, type SessionIdentityInstance, type SessionIdentityTab } from '@ion/shared/tab-predicates'
import type { Message } from '@ion/shared/types'

function log(message: string, fields?: Record<string, unknown>): void {
  _log('main', message, fields)
}

export interface TabSessionChain {
  sessionIds: string[]
  tabStatus?: string
  conversationId: string | null
  source: 'renderer_cache' | 'persisted_active' | 'persisted_settled'
}

interface PersistedRecord extends SessionIdentityTab {
  id?: string
  status?: string
  conversationPane?: {
    activeInstanceId?: string | null
    instances?: Array<SessionIdentityInstance & { id?: string; currentSessionId?: string; sessions?: Array<{ id?: string }> }>
  }
}

function activePersistedInstance(tab: PersistedRecord): SessionIdentityInstance | null {
  const instances = tab.conversationPane?.instances ?? []
  const activeId = tab.conversationPane?.activeInstanceId
  const instance = instances.find((candidate) => candidate.id === activeId) ?? instances[0]
  if (!instance) return null
  return {
    conversationIds: [
      ...(instance.sessions ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string'),
      ...(instance.conversationIds ?? []),
      ...(instance.currentSessionId ? [instance.currentSessionId] : []),
    ],
    statusFields: instance.statusFields,
  }
}

function fromRecord(tab: PersistedRecord, source: TabSessionChain['source']): TabSessionChain | null {
  const sessionIds = orderedSessionIds(tab, activePersistedInstance(tab))
  if (sessionIds.length === 0) return null
  return {
    sessionIds,
    tabStatus: typeof tab.status === 'string' ? tab.status : undefined,
    conversationId: tab.conversationId ?? sessionIds.at(-1) ?? null,
    source,
  }
}

export async function resolveTabSessionChain(tabId: string): Promise<TabSessionChain | null> {
  const cached = state.rendererSnapshotCache?.tabs.find((tab) => tab.id === tabId)
  if (cached) {
    const sessionIds = orderedSessionIds(cached)
    if (sessionIds.length > 0) {
      log('load_conversation: session chain resolved', { tab_id: tabId, source: 'renderer_cache', sessions: sessionIds.length })
      return { sessionIds, tabStatus: cached.status, conversationId: cached.conversationId ?? sessionIds.at(-1) ?? null, source: 'renderer_cache' }
    }
  }

  try {
    if (!existsSync(tabsFile())) return null
    const data = JSON.parse(readFileSync(tabsFile(), 'utf-8')) as { tabs?: PersistedRecord[]; settledHistory?: PersistedRecord[] } | PersistedRecord[]
    const active = Array.isArray(data) ? data : (Array.isArray(data.tabs) ? data.tabs : [])
    const settled = Array.isArray(data) ? [] : (Array.isArray(data.settledHistory) ? data.settledHistory : [])
    const record = active.find((tab) => tab.id === tabId)
    const source: TabSessionChain['source'] = record ? 'persisted_active' : 'persisted_settled'
    const chain = fromRecord(record ?? settled.find((tab) => tab.id === tabId) ?? {}, source)
    if (chain) log('load_conversation: session chain resolved', { tab_id: tabId, source, sessions: chain.sessionIds.length })
    return chain
  } catch (error) {
    log('load_conversation: persisted tabs read failed', { tab_id: tabId, error: String(error) })
    return null
  }
}

/**
 * Hard ceiling on messages in a single history page, applied AFTER the
 * turn-boundary snap. The snap walks backward to the start of a turn so a
 * client never renders a partial turn — but a pathological single turn (e.g.
 * a long agent run with hundreds of tool messages) would otherwise produce a
 * multi-MB frame. When a turn exceeds this cap, the page starts mid-turn and
 * the client pages the remainder via hasMore — a bounded frame beats a whole
 * turn.
 */
export const MAX_PAGE_MESSAGES = 80;

/** Default page size for a mirror connection's paged body request. */
export const PAGE_SIZE = 10;

/**
 * Ceiling for an explicitly requested BULK page.
 *
 * Sized against the transport, not guessed: the relay caps a frame at 12 MB
 * (`relay/relay.go` MaxMessageSize) and a measured transcript averages ~1.3 KB
 * per row after the tool-content cap below, so 2000 rows is ~2.6 MB — comfortably
 * inside one frame with headroom for an atypically heavy conversation.
 *
 * This exists because the default page (10 rows, turn-snapped) is tuned for
 * first paint, and a client that needs the WHOLE conversation — to scroll back
 * without stutter, or to jump to a row in older history — would otherwise pay
 * hundreds of round trips and hundreds of transcript rebuilds to get it.
 */
export const BULK_PAGE_MESSAGES = 2000;

/** Maximum content chars carried per tool row over the wire. */
const TOOL_CONTENT_CAP = 2048;

/** Byte ceiling of one page, half the connection's 8 MiB send cap. */
export const HISTORY_PAGE_BYTE_BUDGET = 4 * 1024 * 1024;

export interface HistoryPage {
  page: Message[];
  hasMore: boolean;
  cursor?: string;
  total: number;
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
export function paginateHistory(
  all: readonly Message[],
  before?: string,
  pageSize: number = PAGE_SIZE,
): HistoryPage {
  const total = all.length;
  let endIdx = total;
  let startIdx = Math.max(0, total - pageSize);

  if (before) {
    const cursorIdx = all.findIndex((m) => m.id === before);
    if (cursorIdx > 0) {
      endIdx = cursorIdx;
      startIdx = Math.max(0, endIdx - pageSize);
    }
  }

  // Snap backward to a turn boundary (user message) to avoid partial turns.
  while (startIdx > 0 && all[startIdx] && all[startIdx].role !== "user") {
    startIdx--;
  }

  // The per-page ceiling follows the REQUESTED size: a default page stays
  // bounded at MAX_PAGE_MESSAGES so a turn-snap cannot balloon it, while an
  // explicit bulk request is allowed its larger window.
  const ceiling = pageSize > PAGE_SIZE ? BULK_PAGE_MESSAGES : MAX_PAGE_MESSAGES;
  if (endIdx - startIdx > ceiling) {
    startIdx = endIdx - ceiling;
  }

  const page = all.slice(startIdx, endIdx).map((m) => {
    if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > TOOL_CONTENT_CAP
    ) {
      return {
        ...m,
        content: m.content.substring(0, TOOL_CONTENT_CAP) + "\n... [truncated]",
      };
    }
    return m;
  });

  // Bound the page by bytes as well as rows. A page of heavy rows (long
  // assistant replies, attachments) overflowed the connection's 8 MiB send
  // cap on row count alone, and the socket was closed mid-write. Rows are
  // dropped from the oldest end; they belong to the next older page.
  let bytes = 0;
  let keepFrom = page.length;
  while (keepFrom > 0) {
    const size = Buffer.byteLength(JSON.stringify(page[keepFrom - 1]), "utf-8");
    if (keepFrom < page.length && bytes + size > HISTORY_PAGE_BYTE_BUDGET) break;
    bytes += size;
    keepFrom--;
  }
  const bounded = keepFrom > 0 ? page.slice(keepFrom) : page;
  startIdx += keepFrom;

  const hasMore = startIdx > 0;
  return {
    page: bounded,
    hasMore,
    cursor: hasMore && bounded.length > 0 ? bounded[0].id : undefined,
    total,
  };
}

/** A requested page size, clamped to [PAGE_SIZE, BULK_PAGE_MESSAGES]; absent means PAGE_SIZE. */
export function clampPageSize(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), PAGE_SIZE), BULK_PAGE_MESSAGES)
    : PAGE_SIZE
}
