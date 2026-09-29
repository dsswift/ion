/**
 * mirror-projection — per-connection payload projection for the
 * `'per-principal'` Studio wire channels (`@ion/shared/studio-wire/channels`).
 *
 * A `'tab'`-scoped channel is a yes/no visibility gate (`events.ts`'s
 * `visibleTo`): the whole payload goes to a connection or it doesn't. These
 * three channels are different — each payload is a whole-store projection
 * naming several tabs/conversations at once (`studio:tabs-sync`'s `tabs`
 * array, `studio:conversation-terminals`'s `panes`, `studio:worktree-sync`'s
 * repo/bench inventory) — so visibility is always "yes" but the CONTENT must
 * be cut down to what the connecting principal owns before it leaves the
 * process. This is the fix for the multi-tenant gap report's A1: these three
 * channels were broadcast unfiltered, so `studio:tabs-sync` sent every
 * principal's tab titles, working directories, conversation ids, live
 * statuses, and staged attachment content to every connection on every
 * persistence tick.
 *
 * `conn.principal === null` (a `local`/`paired` connection — the trusted,
 * single-owner desktop case) always gets the payload unfiltered: that
 * connection IS the store owner, there is nothing to isolate it from, and
 * this must not regress today's desktop behavior.
 */
import type { PersistedTab, PersistedTabState, FileAttachment, TabStatus } from '@ion/shared/types'
import type { StudioWorktreeSnapshot } from '@ion/shared/types-studio'
import type { StudioConversationTerminalPublish } from '@ion/shared/studio-conversation-terminal-sync'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import type { Connection } from './connection'
import { principalSubjectForTab } from './tabs-index'
import { unownedTabsVisible, isSharedTenancy } from '../config/current'

/** True when `tabId`'s owner is `subject`, or the record is unresolved on a non-multi-tenant server (same rule as A3's other three sites). */
function ownsTab(tabId: string, subject: string): boolean {
  if (isSharedTenancy()) return true
  const owner = principalSubjectForTab(tabId)
  if (!owner) return unownedTabsVisible()
  return owner === subject
}

interface TabsSyncPayload extends PersistedTabState {
  revision: number
  liveTabStatus: Record<string, TabStatus>
  liveIsCompacting: Record<string, boolean>
  liveResolvedModel?: Record<string, Record<string, string>>
  queuedAttachments: Record<string, FileAttachment[]>
}

function pickOwned<T extends { id?: string }>(tabs: T[], subject: string): T[] {
  return tabs.filter((t) => (typeof t.id === 'string' ? ownsTab(t.id, subject) : unownedTabsVisible()))
}

function pickOwnedRecord<V>(record: Record<string, V>, subject: string): Record<string, V> {
  const out: Record<string, V> = {}
  for (const [tabId, value] of Object.entries(record)) {
    if (ownsTab(tabId, subject)) out[tabId] = value
  }
  return out
}

/**
 * `activeTabIndex` is only meaningful against the FILTERED `tabs` array — a
 * connection must never see an index pointing at a tab it can't see. Resolves
 * by identity (the original active tab's `id`) rather than by carrying the
 * raw index through, since filtering can shift every position after it.
 */
function projectedActiveTabIndex(payload: TabsSyncPayload, filteredTabs: PersistedTab[]): number | null {
  if (payload.activeTabIndex == null) return null
  const activeTab = payload.tabs[payload.activeTabIndex]
  if (!activeTab?.id) return null
  const idx = filteredTabs.findIndex((t) => t.id === activeTab.id)
  return idx >= 0 ? idx : null
}

function projectTabsSync(payload: TabsSyncPayload, subject: string): TabsSyncPayload {
  const tabs: PersistedTab[] = pickOwned(payload.tabs, subject)
  const settledHistory = payload.settledHistory ? pickOwned(payload.settledHistory, subject) : payload.settledHistory
  return {
    ...payload,
    tabs,
    settledHistory,
    activeTabIndex: projectedActiveTabIndex(payload, tabs),
    liveTabStatus: pickOwnedRecord(payload.liveTabStatus, subject),
    liveIsCompacting: pickOwnedRecord(payload.liveIsCompacting, subject),
    ...(payload.liveResolvedModel ? { liveResolvedModel: pickOwnedRecord(payload.liveResolvedModel, subject) } : {}),
    queuedAttachments: pickOwnedRecord(payload.queuedAttachments, subject),
  }
}

function projectConversationTerminals(payload: StudioConversationTerminalPublish, subject: string): StudioConversationTerminalPublish {
  return {
    ...payload,
    panes: payload.panes.filter((p) => ownsTab(p.tabId, subject)),
    openTabIds: payload.openTabIds.filter((tabId) => ownsTab(tabId, subject)),
  }
}

/** Empty-but-valid worktree snapshot: same shape, no content. */
function emptyWorktreeSnapshot(payload: StudioWorktreeSnapshot): StudioWorktreeSnapshot {
  return {
    revision: payload.revision,
    ready: payload.ready,
    inventory: {},
    workspaces: {},
    benchSourceTips: [],
    benchRetired: [],
    gitConflictAlerts: [],
    worktreePipeline: null,
    workspaceOperationLedger: [],
  }
}

/**
 * Worktree/bench inventory is keyed by repo/bench path, not by tab — there is
 * no tab-ownership dimension to project through. Gated on capability instead:
 * a connection without `git:write` holds no scope that lets it act on
 * worktree data anyway, so it gets an empty-but-valid snapshot rather than
 * the real one. A `git:write` connection (the trusted pe-developer class)
 * sees this unchanged from today.
 */
function projectWorktreeSync(payload: StudioWorktreeSnapshot, conn: Connection): StudioWorktreeSnapshot {
  if (scopeSatisfies(conn.scopes, 'git:write')) return payload
  return emptyWorktreeSnapshot(payload)
}

/** Project a `'per-principal'` channel's payload down to `conn`'s own principal. Identity for every other channel and for a principal-less (local/paired) connection. */
export function projectForConnection(channel: string, payload: unknown, conn: Connection): unknown {
  if (conn.principal === null) return payload
  const subject = conn.principal.subject
  switch (channel) {
    case 'studio:tabs-sync':
      return projectTabsSync(payload as TabsSyncPayload, subject)
    case 'studio:conversation-terminals':
      return projectConversationTerminals(payload as StudioConversationTerminalPublish, subject)
    case 'studio:worktree-sync':
      return projectWorktreeSync(payload as StudioWorktreeSnapshot, conn)
    default:
      return payload
  }
}
