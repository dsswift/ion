import type { TabState, Message } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'
import { makeMainPane } from '../conversation-instance'
import { buildRestoredDenied } from './resume-slice-restore-denied'
import { mapSessionHistory, mapSessionMessage } from '../../../shared/session-message-mapper'
import { loadSkeletonMessagesImpl } from '../resume-slice-hydration'
import { rInfo, rWarn } from '../../rendererLogger'
import { resolveRegisteredWorktree } from '../worktree-registration'


export function createResumeSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    resumeSession: async (sessionId, title, projectPath, customTitle, encodedDir) => {
      const defaultDir = projectPath || get().staticInfo?.homePath || '~'
      // HistoryPicker and boot restoration both enter here. Resolve before either
      // success or fallback tab is written so first render has correct repo identity.
      const worktree = await resolveRegisteredWorktree(defaultDir)
      try {
        const { tabId } = await window.ion.createTab()

        // One attempt, no retry ladder. An empty history is a VALID answer — a
        // brand-new conversation has no rows on disk — not a transient state
        // worth waiting on. The old code looped three times with 2s and 4s
        // backoff whenever `history.length === 0`, so every restore of a fresh
        // conversation slept 6 seconds before the tab appeared, and on the
        // boot-active tab that delay preceded the whole restore sequence.
        // loadSkeletonMessages already made this call once for the same reason
        // ("the engine is already running and the files are on disk"); this is
        // the sibling path that kept the ladder.
        //
        // A genuine IPC throw still lands in the outer catch, which builds the
        // empty-pane fallback tab, so a real failure is not silently treated as
        // an empty conversation.
        let history: any[] = []
        try {
          history = await window.ion.loadSession(sessionId, defaultDir, encodedDir || undefined)
        } catch (err) {
          rWarn('session.resume', 'loadSession failed', { session_id: sessionId.slice(0, 24), error: String(err) })
        }
        // Map engine history rows → client Messages via the shared mapper,
        // which also converts system-role marker rows (compaction/plan/steer)
        // into the same divider Messages the live handlers produce.
        const messages: Message[] = mapSessionHistory(history, nextMsgId)

        const restoredDenied = buildRestoredDenied(messages)

        const { tabGroupMode, tabGroups } = usePreferencesStore.getState()
        const groupId = tabGroupMode === 'manual'
          ? (tabGroups.find((g) => g.isDefault)?.id || tabGroups[0]?.id || null)
          : null

        const tab: TabState = {
          ...makeLocalTab(),
          id: tabId,
          conversationId: sessionId,
          lastKnownSessionId: sessionId,
          title: title || 'Resumed Session',
          customTitle: customTitle || null,
          workingDirectory: defaultDir,
          hasChosenDirectory: !!projectPath,
          groupId,
          worktree,
        }
        // Seed the resumed tab's `main` pane with the loaded scrollback + denial.
        rInfo('session.resume', 'resume session', { tab_id: tab.id.slice(0, 8), count: messages.length, restored_denied: restoredDenied })
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({
            messages,
            messageCount: messages.length,
            permissionDenied: restoredDenied,
          })),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        return tabId
      } catch {
        const { tabGroupMode: tgm, tabGroups: tgs } = usePreferencesStore.getState()
        const groupId = tgm === 'manual'
          ? (tgs.find((g) => g.isDefault)?.id || tgs[0]?.id || null)
          : null

        const tab = makeLocalTab()
        tab.conversationId = sessionId
        tab.lastKnownSessionId = sessionId
        tab.title = title || 'Resumed Session'
        tab.customTitle = customTitle || null
        tab.workingDirectory = defaultDir
        tab.hasChosenDirectory = !!projectPath
        tab.groupId = groupId
        tab.worktree = worktree
        // Seed an empty `main` pane even on the error path so the tab is usable.
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane()),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        return tab.id
      }
    },

    loadSkeletonMessages: loadSkeletonMessagesImpl(set, get),

    rehydrateFailedHistory: () => {
      // Engine is reachable again: re-arm hydration for every pane whose
      // history load failed while it was down. Markers are reset here; the
      // actual reload is lazy — the active tab reloads immediately below, and
      // background tabs reload on their next activation through the existing
      // needsHistoryHydration gate in selectTab. This avoids re-firing 30
      // simultaneous history loads at an engine that just came back up.
      const failedTabIds: string[] = []
      set((s) => {
        const conversationPanes = new Map(s.conversationPanes)
        for (const [tabId, pane] of conversationPanes) {
          if (!pane.instances.some((i) => i.historyHydrationFailed)) continue
          failedTabIds.push(tabId)
          conversationPanes.set(tabId, {
            ...pane,
            instances: pane.instances.map((i) =>
              i.historyHydrationFailed
                ? {
                    ...i,
                    historyHydrated: false,
                    historyHydrationFailed: false,
                    // Any external-content pane re-enters the external path so
                    // the content-file + engine-chain merge reruns whole (a
                    // chain-failed pane may have been marked 'loaded' with
                    // engine rows missing). Non-external panes (undefined)
                    // pass through unchanged.
                    ...(i.externalContentStatus
                      ? { externalContentStatus: 'pending' as const }
                      : {}),
                  }
                : i,
            ),
          })
        }
        return failedTabIds.length > 0 ? { conversationPanes } : {}
      })
      if (failedTabIds.length === 0) return
      rInfo('session.restore', 'rehydrating failed history after engine reconnect', { tab_count: failedTabIds.length })
      const activeTabId = get().activeTabId
      if (activeTabId && failedTabIds.includes(activeTabId)) {
        void get().loadSkeletonMessages(activeTabId)
      }
    },

    resumeSessionWithChain: async (sessionId, historicalSessionIds, title, projectPath, customTitle, encodedDir) => {
      const defaultDir = projectPath || get().staticInfo?.homePath || '~'
      try {
        const { tabId } = await window.ion.createTab()

        const allMessages: Message[] = []
        for (const histId of historicalSessionIds) {
          const history = await window.ion.loadSession(histId, defaultDir, encodedDir || undefined).catch(() => [])
          for (const m of history) {
            if (m.internal) continue
            const mapped = mapSessionMessage(m, nextMsgId)
            if (mapped) allMessages.push(mapped)
          }
        }

        const currentHistory = await window.ion.loadSession(sessionId, defaultDir, encodedDir || undefined).catch(() => [])
        for (const m of currentHistory) {
          if (m.internal) continue
          const mapped = mapSessionMessage(m, nextMsgId)
          if (mapped) allMessages.push(mapped)
        }

        const restoredDenied = buildRestoredDenied(allMessages)

        const { tabGroupMode, tabGroups } = usePreferencesStore.getState()
        const groupId = tabGroupMode === 'manual'
          ? (tabGroups.find((g) => g.isDefault)?.id || tabGroups[0]?.id || null)
          : null

        const tab: TabState = {
          ...makeLocalTab(),
          id: tabId,
          conversationId: sessionId,
          lastKnownSessionId: sessionId,
          historicalSessionIds,
          title: title || 'Resumed Session',
          customTitle: customTitle || null,
          workingDirectory: defaultDir,
          hasChosenDirectory: !!projectPath,
          groupId,
        }
        // Seed the resumed tab's `main` pane with the loaded chain scrollback.
        rInfo('session.resume', 'resume session with chain', { tab_id: tab.id.slice(0, 8), count: allMessages.length, restored_denied: !!restoredDenied })
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({
            messages: allMessages,
            messageCount: allMessages.length,
            permissionDenied: restoredDenied,
          })),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        return tabId
      } catch {
        const { tabGroupMode: tgm, tabGroups: tgs } = usePreferencesStore.getState()
        const groupId = tgm === 'manual'
          ? (tgs.find((g) => g.isDefault)?.id || tgs[0]?.id || null)
          : null

        const tab = makeLocalTab()
        tab.conversationId = sessionId
        tab.lastKnownSessionId = sessionId
        tab.historicalSessionIds = historicalSessionIds
        tab.title = title || 'Resumed Session'
        tab.customTitle = customTitle || null
        tab.workingDirectory = defaultDir
        tab.hasChosenDirectory = !!projectPath
        tab.groupId = groupId
        // Seed an empty `main` pane even on the error path so the tab is usable.
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane()),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        return tab.id
      }
    },
  }
}
