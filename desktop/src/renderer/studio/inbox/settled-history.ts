import type { TabState } from '../../../shared/types'
import type { IntegrationWorkspace } from '../../../shared/types-bench'
import { fuzzyMatchCommand } from '../../../shared/fuzzy-match'
import { inboxProjectFor, inboxWorktreeFor } from './inbox-grouping'
import type { WorktreeInventoryEntry } from '../../../shared/types'

/** Number of days that conversations remain recoverable in Settled History. */
export const SETTLED_HISTORY_CUTOFF_DAYS = 90

/** Number of settled conversations to show on each history page. */
export const SETTLED_HISTORY_PAGE_SIZE = 50

const DAY_MS = 24 * 60 * 60 * 1_000

/**
 * Separates the bounded settled-history window from records that stay on disk.
 * `recent` feeds the compact shelf (which renders its own short page); `history`
 * feeds the full view. Both contain only records settled in the last 90 days.
 */
export function partitionSettled(
  settled: TabState[],
  now: number,
): { recent: TabState[]; history: TabState[] } {
  const cutoff = now - SETTLED_HISTORY_CUTOFF_DAYS * DAY_MS
  const recent: TabState[] = []
  const history: TabState[] = []

  for (const tab of settled) {
    if (tab.settledAt == null || tab.settledAt >= cutoff) {
      recent.push(tab)
      history.push(tab)
    }
  }

  return { recent, history }
}

/**
 * Returns settled conversations whose title or project name fuzzy-matches a query.
 * An empty query returns every conversation in its current order.
 */
export function searchSettledTabs(
  tabs: ReadonlyArray<TabState>,
  query: string,
  benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>,
  inventory: ReadonlyMap<string, readonly WorktreeInventoryEntry[]> = new Map(),
): TabState[] {
  if (query.length === 0) return [...tabs]

  return tabs.filter((tab) => {
    const title = tab.customTitle || tab.title
    const project = inboxProjectFor(tab, benches).name
    const worktree = inboxWorktreeFor(tab, benches, inventory).label
    return fuzzyMatchCommand(query, title) !== null
      || fuzzyMatchCommand(query, project) !== null
      || fuzzyMatchCommand(query, worktree) !== null
  })
}

/**
 * Returns one zero-based page of settled history and pagination metadata.
 */
export function paginateSettled(
  tabs: ReadonlyArray<TabState>,
  page: number,
): { page: TabState[]; totalPages: number; hasMore: boolean } {
  const totalPages = Math.ceil(tabs.length / SETTLED_HISTORY_PAGE_SIZE)
  const start = page * SETTLED_HISTORY_PAGE_SIZE

  return {
    page: tabs.slice(start, start + SETTLED_HISTORY_PAGE_SIZE),
    totalPages,
    hasMore: page + 1 < totalPages,
  }
}
