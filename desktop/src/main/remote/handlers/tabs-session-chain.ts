import { existsSync, readFileSync } from 'fs'
import { state } from '../../state'
import { TABS_FILE } from '../../settings-store'
import { log as _log } from '../../logger'
import { orderedSessionIds, type SessionIdentityInstance, type SessionIdentityTab } from '../../../shared/tab-predicates'
import type { Message } from '../../../shared/types'
import type { RemoteMessage } from '../protocol-remote-tab'

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
    if (!existsSync(TABS_FILE)) return null
    const data = JSON.parse(readFileSync(TABS_FILE, 'utf-8')) as { tabs?: PersistedRecord[]; settledHistory?: PersistedRecord[] } | PersistedRecord[]
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
 * turn-boundary snap. The snap walks backward to the start of a turn so iOS
 * never renders a partial turn — but a pathological single turn (e.g. a long
 * agent run with hundreds of tool messages) would otherwise produce a
 * multi-MB frame. Serializing/compressing/encrypting that on the main thread
 * is a relay wedge risk. When a turn exceeds this cap, the page starts
 * mid-turn and iOS paginates the remainder via hasMore — a bounded frame
 * beats a whole turn.
 */
export const MAX_PAGE_MESSAGES = 80;

/** Default page size for `desktop_load_conversation`. */
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

  const hasMore = startIdx > 0;
  return {
    page,
    hasMore,
    cursor: hasMore && page.length > 0 ? page[0].id : undefined,
    total,
  };
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
    role: (m.role === "user" || m.role === "assistant" || m.role === "tool"
      ? m.role
      : "system") as RemoteMessage["role"],
    content: m.content || "",
    toolName: m.toolName,
    toolInput: m.toolInput,
    toolId: m.toolId,
    toolStatus: m.toolStatus,
    timestamp: m.timestamp ?? 0,
    slashCommand: m.slashCommand,
    slashArgs: m.slashArgs,
    slashSource: m.slashSource,
    slashModelAlias: m.slashModelAlias,
    slashModelEffective: m.slashModelEffective,
    implementationPhase: m.implementationPhase,
    slashFrontmatter: m.slashFrontmatter,
    planFilePath: m.planFilePath,
    backgroundTaskId: m.backgroundTaskId,
    backgroundWork: m.backgroundWork,
    attachments: (m.attachments || []).map((a) => ({
      id: a.id,
      type: (a.type === "image" || a.type === "file" || a.type === "plan"
        ? a.type
        : "file") as "image" | "file" | "plan",
      name: a.name,
      path: a.path ?? "",
      ...(a.type === "image" && a.contentHash
        ? { contentHash: a.contentHash }
        : {}),
    })),
  };
}

/**
 * Resolve a fallback plan file path for an ExitPlanMode row from the loaded
 * transcript itself: the most recent Write tool row targeting
 * ~/.ion/plans/*.md before falling back to nothing. Replaces the old
 * renderer-scrape IIFE — the engine rows carry the same information.
 */
export function planPathFromHistory(
  all: readonly Message[],
): string | undefined {
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.role === "tool" && m.toolName === "Write" && m.toolInput) {
      try {
        const input = JSON.parse(m.toolInput);
        const fp = input.file_path;
        if (typeof fp === "string" && /\/\.ion\/plans\/[^/]+\.md$/.test(fp))
          return fp;
      } catch {
        // Not JSON tool input — skip.
      }
    }
  }
  return undefined;
}

/** Where an ExitPlanMode row's plan path came from, or that there was none. */
export type PlanPathSource = "tool_input" | "history_write" | "none";

/**
 * Resolve the plan path for an ExitPlanMode row, reporting which source
 * produced it: the path the tool call carried, else the most recent plan-file
 * Write in the transcript, else nothing.
 *
 * The source is returned rather than derived at the log site because it is the
 * field that separates two failures which produce an identical message and need
 * opposite fixes. A `'none'` result means no read was ever attempted (the
 * transcript carries no plan path); a `'tool_input'` or `'history_write'`
 * result that still fails means the path resolved and the FILE could not be
 * read. Without the distinction, "no plan file found" reads as a missing file
 * when it is often a pathless transcript, and the investigation goes to the
 * filesystem instead of the transcript.
 *
 * Split out of the enrichment block in tabs.ts so the rule is testable: that
 * block sits inside an IPC handler that cannot run without a full
 * Electron/engine harness, which is why the resolution went unpinned.
 */
export function resolvePlanPath(
  inputPath: unknown,
  all: readonly Message[],
): { planPath: string | undefined; pathSource: PlanPathSource } {
  // An empty string is treated as absent, not as a path: it would otherwise
  // reach readFile and throw a confusing error instead of taking the honest
  // "no path" branch.
  const fromInput =
    typeof inputPath === "string" && inputPath.length > 0
      ? inputPath
      : undefined;
  const planPath = fromInput ?? planPathFromHistory(all);
  return {
    planPath,
    pathSource: fromInput ? "tool_input" : planPath ? "history_write" : "none",
  };
}
