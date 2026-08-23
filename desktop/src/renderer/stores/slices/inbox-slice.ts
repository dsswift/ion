import type { StoreGet, StoreSet, State } from '../session-store-types'
import { activeInstance, effectivePermissionMode, isEmptyConversation, makeMainPane, needsHistoryHydration } from '../conversation-instance'
import { makeLocalTab } from '../session-store-helpers'
import { pickNextActiveTab } from './tab-slice-next-active'
import { usePreferencesStore } from '../../preferences'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'
import { settledRecordCanRestore } from '../settled-worktree'
import { benchTerminalTitle, isBenchDirectory, pickDirTerminal } from '../../../shared/worktree-conversations'
import { autoSettleBlocked, effectiveSettled, type InboxTabView } from '../../../shared/inbox-classify'
import { liveBackgroundShellCount } from '../../../shared/background-shell-counts'
import { isPersistedSettled } from '../../../shared/tab-predicates'
import { evaluateSessionBusyGuard, formatSessionBusyRefusal } from './session-busy-guard'

function canSnooze(input: { pendingAskCount: number; waiting: boolean; inBench: boolean }): boolean {
  return input.pendingAskCount === 0 && !input.waiting && !input.inBench
}

const TITLE_SOURCE_LIMIT = 6_000

function actionInput(state: State, tabId: string) {
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return null
  const instance = activeInstance(state.conversationPanes, tabId)
  const pendingAskCount = (instance?.permissionQueue.length ?? 0) + (instance?.elicitationQueue.length ?? 0)
  const waiting = instance?.permissionDenied != null
  return {
    tab,
    pendingAskCount,
    waiting,
    // A bench is rebuildable scratch space, so everything in it is ephemeral.
    // Snooze parks a conversation for a later that the next assembly deletes.
    inBench: isBenchDirectory(tab.workingDirectory, benchPaths(state)),
    hasPendingPlan: instance?.planFilePath != null,
  }
}

function automaticSettlementView(state: State, tabId: string): InboxTabView | null {
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return null
  const instance = activeInstance(state.conversationPanes, tabId)
  const pendingAskCount = (instance?.permissionQueue.length ?? 0) + (instance?.elicitationQueue.length ?? 0)
  const agentCount = instance?.agentStates.filter((agent) => agent.status === 'running').length ?? 0
  const backgroundAgents = instance?.statusFields?.backgroundAgents ?? 0
  const shells = liveBackgroundShellCount(instance?.statusFields)
  return {
    status: tab.status,
    settledOverride: tab.settledOverride,
    settledAt: tab.settledAt,
    snoozedUntil: tab.snoozedUntil,
    snoozedAt: tab.snoozedAt,
    lastVisitedAt: tab.lastVisitedAt,
    lastCompletionAt: tab.lastCompletionAt,
    lastMessageAt: tab.lastMessageAt,
    lastActivityAt: tab.lastActivityAt,
    manualUnread: tab.manualUnread,
    hasPendingPlan: instance?.planFilePath != null,
    hasPendingWork: Math.max(agentCount, backgroundAgents) > 0 || shells > 0 || instance?.statusFields?.hasPendingWork === true,
    pendingAskCount,
    waiting: instance?.permissionDenied != null,
    failed: tab.status === 'failed',
  }
}

/** Every bench checkout path the store currently knows, across all repos. */
function benchPaths(state: State): string[] {
  return [...(state.benchWorkspaces ?? new Map()).values()].flatMap((list) => list.map((workspace) => workspace.benchPath))
}

/** Owner-durable inbox actions. Studio forwards all mutations to this slice. */
export function createInboxSlice(set: StoreSet, get: StoreGet): Partial<State> {
  const settle = async (tabId: string, provenance: 'settled' | 'auto'): Promise<void> => {
    const startingTab = get().tabs.find((candidate) => candidate.id === tabId)
    // A record already carrying a settled marker is either mid-transition or,
    // far more commonly, a settled-history record spliced into `tabs` for
    // read-only review (selectTab in tab-slice.ts) — it keeps its marker so
    // navigating away re-files it unchanged. Re-settling it here would
    // overwrite its real settledAt/settledOverride with this call's
    // provenance and today's date, which is exactly how a manually-settled
    // record reachable only by opening it for review got silently rewritten
    // into an auto-settle. The mutation itself refuses, not just the sweep
    // that is its one current caller, so no future caller can reintroduce it.
    if (startingTab && isPersistedSettled(startingTab)) {
      rWarn('inbox', 'settle refused because the tab already carries a settled record', {
        tab_id: tabId.slice(0, 8), provenance, existing_override: startingTab.settledOverride,
      })
      return
    }
    if (!actionInput(get(), tabId)) {
      rWarn('inbox', 'settle rejected because tab is absent', { tab_id: tabId.slice(0, 8), provenance })
      return
    }
    const historyNeedsHydration = needsHistoryHydration(activeInstance(get().conversationPanes, tabId))
    if (provenance === 'auto' && historyNeedsHydration) {
      rDebug('inbox', 'automatic settlement skipped until history hydration completes', { tab_id: tabId.slice(0, 8) })
      return
    }
    if (historyNeedsHydration) {
      rDebug('inbox', 'hydrating scrollback before settlement', { tab_id: tabId.slice(0, 8), provenance })
      await get().loadSkeletonMessages(tabId)
    }
    const input = actionInput(get(), tabId)
    if (!input) {
      rWarn('inbox', 'settle rejected because tab closed during hydration', { tab_id: tabId.slice(0, 8), provenance })
      return
    }
    if (provenance === 'auto') {
      const view = automaticSettlementView(get(), tabId)
      if (!view) return
      if (!effectiveSettled(view, Date.now(), usePreferencesStore.getState().inboxAutoSettleDays || null)) {
        rDebug('inbox', 'automatic settlement skipped because clock no longer qualifies', { tab_id: tabId.slice(0, 8) })
        return
      }
      const blocked = autoSettleBlocked(view)
      if (blocked) {
        rDebug('inbox', 'automatic settlement refused', { tab_id: tabId.slice(0, 8), reason: blocked })
        return
      }
    }
    if (isEmptyConversation(input.tab, get().conversationPanes.get(tabId))) {
      rInfo('inbox', 'empty conversation settlement routed to permanent removal', {
        tab_id: tabId.slice(0, 8), has_conversation_id: input.tab.conversationId !== null, provenance,
      })
      void get().deleteConversationTab(tabId)
      return
    }
    rInfo('inbox', 'settlement requested', {
      tab_id: tabId.slice(0, 8), provenance, pending_plan: input.hasPendingPlan,
      pending_asks: input.pendingAskCount, waiting_for_decision: input.waiting,
    })
    try {
      await window.ion.engineStop(tabId)
    } catch (error) {
      rWarn('inbox', 'settle rejected because engine session did not stop', { tab_id: tabId.slice(0, 8), provenance, error: String(error) })
      return
    }
    const settledRecord = { ...input.tab, settledOverride: provenance, settledAt: Date.now(), pinnedAt: null, pinOrderKey: null, inputLocked: true, inputLockReason: 'settled' as const }
    let nextTabId: string | null = null
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== tabId)
      const settledHistory = [...state.settledHistory.filter((tab) => tab.id !== tabId), settledRecord]
      if (tabs.length === 0) {
        const replacement = makeLocalTab()
        nextTabId = replacement.id
        return { tabs: [replacement], activeTabId: replacement.id, settledHistory, conversationPanes: new Map([[replacement.id, makeMainPane({})]]) }
      }
      if (state.activeTabId === tabId) nextTabId = pickNextActiveTab(tabId, state.tabs)?.tabId ?? tabs[0].id
      return { tabs, ...(nextTabId ? { activeTabId: nextTabId } : {}), settledHistory, conversationPanes: new Map([...state.conversationPanes].filter(([id]) => id !== tabId)) }
    })
    if (nextTabId && nextTabId !== tabId) get().selectTab(nextTabId)
    rDebug('inbox', 'settled conversation removed from active workspace', { tab_id: tabId.slice(0, 8), provenance })
  }

  return {
    toggleInboxPanel: () => {
      set((state) => {
        if (state.inboxPanelOpen) return { inboxPanelOpen: false }
        const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
        const nextExplorerDirs = new Set(state.fileExplorerOpenDirs)
        if (tab) nextExplorerDirs.delete(tab.workingDirectory)
        return { inboxPanelOpen: true, fileExplorerOpenDirs: nextExplorerDirs }
      })
    },
    closeInboxPanel: () => set({ inboxPanelOpen: false }),
    settleTab: async (tabId) => settle(tabId, 'settled'),
    autoSettleTab: async (tabId) => settle(tabId, 'auto'),
    restoreSettledHistoryTab: async (tabId) => {
      const record = get().settledHistory.find((tab) => tab.id === tabId)
      if (!record) {
        rWarn('inbox', 'settled review rejected because record is absent', { tab_id: tabId.slice(0, 8) })
        return false
      }
      if (!await settledRecordCanRestore(record)) return false
      set((state) => ({ tabs: [...state.tabs, record], settledHistory: state.settledHistory.filter((tab) => tab.id !== tabId), conversationPanes: new Map(state.conversationPanes).set(tabId, makeMainPane({ messages: [], historyHydrated: false })) }))
      get().selectTab(tabId)
      rDebug('inbox', 'opened settled history record for read-only review', { tab_id: tabId.slice(0, 8) })
      return true
    },
    unsettleTab: async (tabId, reason) => {
      const tab = get().tabs.find((candidate) => candidate.id === tabId) ?? get().settledHistory.find((candidate) => candidate.id === tabId)
      if (!tab) {
        rWarn('inbox', 'unsettle rejected because record is absent', { tab_id: tabId.slice(0, 8) })
        return false
      }
      if (!await settledRecordCanRestore(tab)) return false
      if (!get().tabs.some((candidate) => candidate.id === tabId)) {
        const restored = await get().restoreSettledHistoryTab(tabId)
        if (!restored) return false
      }
      const profile = tab.engineProfileId ? usePreferencesStore.getState().engineProfiles.find((candidate) => candidate.id === tab.engineProfileId) : null
      try {
        const result = profile
          ? await window.ion.engineStart(tabId, { profileId: profile.id, extensions: profile.extensions, workingDirectory: tab.workingDirectory, ...(tab.conversationId ? { sessionId: tab.conversationId } : {}) })
          : await window.ion.ensureEngineSession({ tabId, workingDirectory: tab.workingDirectory, conversationId: tab.conversationId, permissionMode: effectivePermissionMode(tab, get().conversationPanes) })
        if (!result.ok) {
          rWarn('inbox', 'unsettle rejected because engine session did not start', { tab_id: tabId.slice(0, 8), error: result.error ?? 'unknown' })
          return false
        }
      } catch (error) {
        rWarn('inbox', 'unsettle failed', { tab_id: tabId.slice(0, 8), error: String(error) })
        return false
      }
      set((state) => ({ tabs: state.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, settledOverride: reason === 'user' ? 'active' as const : null, settledAt: null, inputLocked: false, inputLockReason: null } : candidate) }))
      get().selectTab(tabId)
      rDebug('inbox', 'unsettled conversation resumed in active workspace', { tab_id: tabId.slice(0, 8), profile_id: profile?.id ?? 'plain' })
      return true
    },
    snoozeTab: (tabId, untilMs) => {
      const input = actionInput(get(), tabId)
      const now = Date.now()
      if (!input) {
        rWarn('inbox', 'snooze rejected because tab is absent', { tab_id: tabId.slice(0, 8) })
        return
      }
      if (input.inBench) {
        rWarn('inbox', 'snooze refused because the conversation lives in an integration bench', {
          tab_id: tabId.slice(0, 8),
          working_directory: input.tab.workingDirectory,
        })
        return
      }
      if (!Number.isFinite(untilMs) || untilMs <= now || !canSnooze({ ...input.tab, ...input })) {
        rWarn('inbox', 'snooze rejected because wake or conversation state is invalid', { tab_id: tabId.slice(0, 8), until_ms: untilMs })
        return
      }
      set((state) => ({
        tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, snoozedUntil: untilMs, snoozedAt: now } : tab),
      }))
      rDebug('inbox', 'snoozed tab', { tab_id: tabId.slice(0, 8), until_ms: untilMs })
    },
    unsnoozeTab: (tabId) => set((state) => ({
      tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, snoozedUntil: null, snoozedAt: null } : tab),
    })),
    markTabUnread: (tabId) => set((state) => ({
      tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, manualUnread: true } : tab),
    })),
    markTabRead: (tabId) => {
      const visitedAt = Date.now()
      set((state) => ({
        tabs: state.tabs.map((tab) => tab.id === tabId
          ? { ...tab, lastVisitedAt: visitedAt, manualUnread: false }
          : tab),
      }))
      rDebug('inbox', 'tab marked reviewed', { tab_id: tabId.slice(0, 8), visited_at: visitedAt })
    },
    pinTab: (tabId) => {
      const state = get()
      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) {
        rWarn('inbox', 'pin rejected because tab is absent', { tab_id: tabId.slice(0, 8) })
        return false
      }
      const workspace = [...state.benchWorkspaces.values()].flatMap((list) => list)
        .find((candidate) => isBenchDirectory(tab.workingDirectory, [candidate.benchPath]))
      if (workspace) {
        const terminal = pickDirTerminal(state.tabs, workspace.benchPath, benchTerminalTitle(workspace.sourceBranch))
        if (!tab.isTerminalOnly || terminal?.id !== tab.id) {
          rWarn('inbox', 'pin refused because the tab is not the bench terminal', {
            tab_id: tabId.slice(0, 8),
            working_directory: tab.workingDirectory,
            tab_role: tab.tabRole ?? 'none',
          })
          return false
        }
      }
      const now = Date.now()
      set((current) => ({
        tabs: current.tabs.map((candidate) => candidate.id === tabId
          ? { ...candidate, pinnedAt: candidate.pinnedAt ?? now, settledOverride: 'active' as const, settledAt: null, snoozedUntil: null, snoozedAt: null }
          : candidate),
      }))
      rDebug('inbox', 'pinned tab', { tab_id: tabId.slice(0, 8), tab_kind: tab.isTerminalOnly ? 'terminal' : 'conversation' })
      return true
    },
    unpinTab: (tabId) => set((state) => ({
      tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, pinnedAt: null, pinOrderKey: null } : tab),
    })),
    reorderPinnedTabs: (assignments) => {
      const nextKeys = new Map(assignments.map((entry) => [entry.id, entry.orderKey]))
      set((state) => ({
        tabs: state.tabs.map((tab) => nextKeys.has(tab.id) ? { ...tab, pinOrderKey: nextKeys.get(tab.id)! } : tab),
      }))
      rDebug('inbox', 'reordered pinned tabs', { assignment_count: assignments.length })
    },
    deleteConversationTab: async (tabId) => {
      const liveTab = get().tabs.find((candidate) => candidate.id === tabId)
      const tab = liveTab ?? get().settledHistory.find((candidate) => candidate.id === tabId)
      if (!tab) {
        rWarn('inbox', 'conversation deletion rejected because record is absent', { tab_id: tabId.slice(0, 8) })
        return
      }
      const guard = evaluateSessionBusyGuard(liveTab ? get().conversationPanes.get(tabId) : null)
      if (guard.blocked) {
        rWarn('inbox', 'conversation deletion blocked by active work', {
          tab_id: tabId.slice(0, 8),
          reason: formatSessionBusyRefusal(tabId, guard, 'delete the conversation'),
        })
        return
      }
      rInfo('inbox', 'conversation permanent deletion started', { tab_id: tabId.slice(0, 8) })
      const sessionIds = [tab.conversationId, tab.lastKnownSessionId, ...tab.historicalSessionIds].filter((id): id is string => !!id)
      if (sessionIds.length > 0) {
        try {
          await window.ion.deleteStoredConversations([...new Set(sessionIds)])
        } catch (error) {
          rWarn('inbox', 'stored conversation deletion failed', { tab_id: tabId.slice(0, 8), error: String(error) })
          return
        }
      }
      const stillLive = get().tabs.some((candidate) => candidate.id === tabId)
      if (stillLive) get().closeTab(tabId, 'delete')
      set((state) => ({ settledHistory: state.settledHistory.filter((candidate) => candidate.id !== tabId) }))
      rInfo('inbox', 'conversation permanent deletion completed', {
        tab_id: tabId.slice(0, 8), session_count: sessionIds.length, source: stillLive ? 'active' : 'settled',
      })
    },
    regenerateTabTitle: async (tabId) => {
      if (!get().tabs.some((candidate) => candidate.id === tabId)) {
        rWarn('inbox', 'title regeneration rejected because tab is absent', { tab_id: tabId.slice(0, 8) })
        return
      }
      // An inbox row is normally a conversation the operator has NOT opened, so
      // its pane carries the persisted message COUNT and no rows at all. Reading
      // `instance.messages` directly therefore built an EMPTY prompt source, and
      // the no-source branch below returned without regenerating anything — the
      // reported "regenerate title does nothing" defect. Hydrate the scrollback
      // first, exactly as settleTab does before its own emptiness decision.
      if (needsHistoryHydration(activeInstance(get().conversationPanes, tabId))) {
        rDebug('inbox', 'hydrating scrollback before title regeneration', { tab_id: tabId.slice(0, 8) })
        await get().loadSkeletonMessages(tabId)
      }
      // Re-read after the await: hydration REPLACES the pane, and the tab can be
      // closed or settled while the load is in flight.
      const state = get()
      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      const instance = activeInstance(state.conversationPanes, tabId)
      if (!tab || !instance) {
        rWarn('inbox', 'title regeneration rejected because tab closed during hydration', { tab_id: tabId.slice(0, 8) })
        return
      }
      const source = instance.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content.trim())
        .filter(Boolean)
        .join('\n\n')
        .slice(0, TITLE_SOURCE_LIMIT)
      if (!source) {
        rDebug('inbox', 'title regeneration skipped without user content', { tab_id: tabId.slice(0, 8) })
        return
      }
      const priorTitle = tab.customTitle ?? tab.title
      try {
        const title = await window.ion.generateTitle(source)
        const current = get().tabs.find((candidate) => candidate.id === tabId)
        if (!title || !current || (current.customTitle ?? current.title) !== priorTitle) {
          rDebug('inbox', 'title regeneration superseded or empty', { tab_id: tabId.slice(0, 8) })
          return
        }
        get().renameTab(tabId, title)
        rDebug('inbox', 'title regenerated', { tab_id: tabId.slice(0, 8) })
      } catch (error) {
        rWarn('inbox', 'title regeneration failed', { tab_id: tabId.slice(0, 8), error: String(error) })
      }
    },
  }
}
