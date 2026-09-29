/**
 * secondary-store-purge — forget everything ONE Environment published, when
 * this desktop can no longer reach it (ADR-033 union store).
 *
 * The union store merges every connected Environment's tabs, terminals and
 * worktrees into one set of rows. Those rows are a mirror of another
 * machine's live state, and the instant the wire to that machine is down
 * they stop being a mirror and become a photograph: the conversations there
 * keep running, land commits, finish or fail, and nothing of that reaches
 * here. A partition is indistinguishable from a healthy server doing work,
 * which is exactly why the photograph is dangerous -- it invites a decision
 * against state that has already moved.
 *
 * So an Environment that goes offline leaves nothing behind. Its rows are
 * removed rather than dimmed forever; its panes, terminals and worktree
 * slice go with them; and its revision cursors are cleared so the first
 * snapshot after it returns is applied even if that server restarted and
 * its counters went back to zero.
 *
 * The one row that survives is the conversation the operator is LOOKING at.
 * Removing it would yank the window somewhere it was not asked to go, mid
 * read. It stays as an empty shell -- the tab row, no pane, no transcript --
 * and `ConversationView` renders the offline panel for it. Nothing that
 * server said is still on screen; only the fact that the operator was here.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import { destroyTerminalInstance } from '../../components/TerminalInstance'
import { tabEnvironmentId } from '../connection/tab-environment'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { clearEnvironmentSyncCursors } from './secondary-store'
import { dropWorktreeEnvironment } from './secondary-store-worktree-sync'
import { rInfo, rWarn } from '../../rendererLogger'

export interface DropResult {
  removedTabs: number
  keptActiveTabId: string | null
}

/**
 * Drops `environmentId`'s slice of the union store. Never call this for the
 * local Environment: its server owns this window's own store, so emptying it
 * would leave the operator with a blank shell and nothing to return to,
 * while the risk this function exists to remove -- acting on a remote
 * machine's stale state -- is not present on the machine you are sitting at.
 */
export function dropEnvironmentState(environmentId: string): DropResult {
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    rWarn('studio.mirror', 'refusing to drop the local environment from the union store', { environment_id: environmentId })
    return { removedTabs: 0, keptActiveTabId: null }
  }
  const before = useSessionStore.getState()
  const activeTab = before.tabs.find((t) => t.id === before.activeTabId)
  const keptActiveTabId = activeTab && tabEnvironmentId(activeTab) === environmentId ? activeTab.id : null

  const isDropped = (tabId: string): boolean => {
    if (tabId === keptActiveTabId) return false
    const tab = before.tabs.find((t) => t.id === tabId) ?? before.settledHistory.find((t) => t.id === tabId)
    return tab ? tabEnvironmentId(tab) === environmentId : false
  }
  // Every terminal viewer for a dropped tab is torn down: the pane is a live
  // view onto a pty on the other machine, and keeping it would leave the
  // last frame of output painted with no session behind it.
  const doomedTerminals = [...before.terminalPanes.keys()].filter((tabId) => isDropped(tabId) || tabId === keptActiveTabId)

  useSessionStore.setState((s) => {
    const tabs = s.tabs.filter((t) => tabEnvironmentId(t) !== environmentId || t.id === keptActiveTabId)
    const settledHistory = s.settledHistory.filter((t) => tabEnvironmentId(t) !== environmentId)
    const conversationPanes = new Map(s.conversationPanes)
    for (const id of [...conversationPanes.keys()]) {
      // The kept tab loses its pane too -- the transcript IS the stale state.
      if (isDropped(id) || id === keptActiveTabId) conversationPanes.delete(id)
    }
    const terminalPanes = new Map(s.terminalPanes)
    const terminalOpenTabIds = new Set(s.terminalOpenTabIds)
    for (const tabId of doomedTerminals) {
      terminalPanes.delete(tabId)
      terminalOpenTabIds.delete(tabId)
    }
    const activeTabId = keptActiveTabId ?? (tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? null)
    return {
      tabs,
      settledHistory,
      conversationPanes,
      terminalPanes,
      terminalOpenTabIds,
      activeTabId,
      ...(s.terminalTallTabId && !terminalOpenTabIds.has(s.terminalTallTabId) ? { terminalTallTabId: null } : {}),
      ...(s.terminalBigScreenTabId && !terminalOpenTabIds.has(s.terminalBigScreenTabId) ? { terminalBigScreenTabId: null } : {}),
    }
  })
  for (const tabId of doomedTerminals) {
    for (const key of [...before.terminalPanes.get(tabId)?.instances ?? []].map((i) => `${tabId}:${i.id}`)) destroyTerminalInstance(key)
  }
  dropWorktreeEnvironment(environmentId)
  clearEnvironmentSyncCursors(environmentId)

  const removedTabs = before.tabs.length - useSessionStore.getState().tabs.length
  rInfo('studio.mirror', 'environment dropped from the union store', {
    environment_id: environmentId,
    removed_tabs: removedTabs,
    kept_active_tab_id: keptActiveTabId ?? '',
    removed_terminal_tabs: doomedTerminals.length,
  })
  return { removedTabs, keptActiveTabId }
}
