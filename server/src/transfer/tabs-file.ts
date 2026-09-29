/**
 * transfer/tabs-file — shared `tabsFile` read/mutate helpers used by both
 * the export path (persisting `sealPending`) and `seal.ts` (persisting
 * cleared). Extracted so both agree on the same read-modify-write
 * shape instead of drifting.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import type { PersistedTab, PersistedTabState } from '@ion/shared/types-persistence'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('transfer.tabs-file', msg, fields)
}

export function readTabsState(tabsFile: string): PersistedTabState {
  if (!existsSync(tabsFile)) return { activeSessionId: null, tabs: [] }
  try {
    const parsed = JSON.parse(readFileSync(tabsFile, 'utf-8')) as PersistedTabState
    return { ...parsed, tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [] }
  } catch (err) {
    warn('tabs file unreadable', { tabs_file: tabsFile, error: String(err) })
    return { activeSessionId: null, tabs: [] }
  }
}

export function writeTabsState(tabsFile: string, state: PersistedTabState): void {
  mkdirSync(dirname(tabsFile), { recursive: true })
  atomicWriteFileSync(tabsFile, JSON.stringify(state, null, 2), 0o644)
}

export function findTab(state: PersistedTabState, tabId: string): { tab: PersistedTab; index: number } | null {
  const index = state.tabs.findIndex((t) => t.id === tabId)
  return index === -1 ? null : { tab: state.tabs[index], index }
}

/** Read one tab record by id, or null when absent. */
export function readTab(tabsFile: string, tabId: string): PersistedTab | null {
  return findTab(readTabsState(tabsFile), tabId)?.tab ?? null
}

/** Set `tab.sealPending` and persist, before any conversation file is read (spec 10). */
export function persistSealPendingOnTabsFile(
  tabsFile: string,
  tabId: string,
  sealPending: { targetEnvironmentId: string; since: number },
): void {
  const state = readTabsState(tabsFile)
  const found = findTab(state, tabId)
  if (!found) {
    warn('persistSealPendingOnTabsFile: no such tab', { tabs_file: tabsFile, tab_id: tabId })
    return
  }
  state.tabs[found.index] = { ...found.tab, sealPending }
  writeTabsState(tabsFile, state)
}
