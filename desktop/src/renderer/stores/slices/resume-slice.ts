import type { TabState, Message } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'
import { makeMainPane, commitInstance, activeInstance, effectivePermissionMode } from '../conversation-instance'
import { mapSessionHistory, mapSessionMessage } from '../../../shared/session-message-mapper'
import { buildRestoredDenied } from '../restored-denied'
import { loadSkeletonMessagesImpl } from '../resume-slice-hydration'
import { rInfo, rWarn } from '../../rendererLogger'

export function createResumeSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    forkTab: async (sourceTabId) => {
      const source = get().tabs.find((t) => t.id === sourceTabId)
      if (!source || !source.conversationId) return null
      // Source scrollback lives on the source tab's active instance now.
      const sourceInst = activeInstance(get().conversationPanes, sourceTabId)
      if (!sourceInst) throw new Error('Cannot fork a tab whose conversation instance is missing')
      try {
        const { tabId } = await window.ion.createTab()

        const messages: Message[] = sourceInst.messages.map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const restoredDenied = buildRestoredDenied(messages)

        const sourceDisplay = source.customTitle || source.title
        const baseMatch = sourceDisplay.match(/^(.+?)\s*\(\d+\)$/)
        const baseName = baseMatch ? baseMatch[1] : sourceDisplay
        const allTitles = get().tabs.map((t) => t.customTitle || t.title)
        let n = 1
        while (allTitles.includes(`${baseName} (${n})`)) n++
        const forkTitle = `${baseName} (${n})`

        const tab: TabState = {
          ...makeLocalTab(),
          id: tabId,
          conversationId: null,
          forkedFromSessionId: source.conversationId,
          title: source.title,
          customTitle: forkTitle,
          workingDirectory: source.workingDirectory,
          hasChosenDirectory: source.hasChosenDirectory,
          additionalDirs: [...source.additionalDirs],
          pillColor: source.pillColor,
          pillIcon: source.pillIcon,
        }
        // Carry the source instance's permission mode onto the new pane instance.
        const forkMode = effectivePermissionMode(source, get().conversationPanes)
        // Seed the forked tab's `main` pane with the carried-over scrollback +
        // restored denial. modelOverride carries from the source instance.
        rInfo('session.fork', 'fork tab', { source_tab: sourceTabId.slice(0, 8), new_tab: tab.id.slice(0, 8), count: messages.length, restored_denied: restoredDenied })
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({
            messages,
            messageCount: messages.length,
            modelOverride: sourceInst.modelOverride,
            permissionDenied: restoredDenied,
            permissionMode: forkMode,
          })),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        window.ion.setPermissionMode(tabId, forkMode, 'tab_create')
        return tabId
      } catch {
        return null
      }
    },

    rewindToMessage: (tabId, messageId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      // Scrollback lives on the active conversation instance now.
      const inst = activeInstance(get().conversationPanes, tabId)
      if (!inst) throw new Error('Cannot rewind a tab whose conversation instance is missing')
      const idx = inst.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return

      const targetMessage = inst.messages[idx]
      const oldSessionId = tab.conversationId
      const historicalSessionIds = oldSessionId
        ? [...tab.historicalSessionIds, oldSessionId]
        : [...tab.historicalSessionIds]

      rInfo('session.rewind', 'rewind to message', { tab_id: tabId.slice(0, 8), msg_idx: idx, total_msgs: inst.messages.length, keep_msgs: idx, old_session_id: oldSessionId?.slice(0, 16) ?? '', historical_chain_len: historicalSessionIds.length })

      const rewoundMessages = inst.messages.slice(0, idx)
      const restoredDenied = buildRestoredDenied(rewoundMessages)

      window.ion.resetTabSession(tabId)
      // Conversation state (messages, permissionQueue, permissionDenied,
      // draftInput) resets on the active instance; tab-level run state and the
      // one-shot pendingInput reset on the tab.
      set((s) => {
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          messages: rewoundMessages,
          permissionQueue: [],
          elicitationQueue: [],
          permissionDenied: restoredDenied,
          draftInput: targetMessage.content,
        }))
        const tabs = s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                conversationId: null,
                historicalSessionIds,
                forkedFromSessionId: oldSessionId,
                lastResult: null,
                currentActivity: '',
                queuedPrompts: [],
                pendingInput: targetMessage.content,
              }
            : t
        )
        return { tabs, conversationPanes }
      })
    },

    forkFromMessage: async (tabId, messageId) => {
      const source = get().tabs.find((t) => t.id === tabId)
      if (!source) return null
      // Source scrollback lives on the source tab's active instance now.
      const sourceInst = activeInstance(get().conversationPanes, tabId)
      if (!sourceInst) throw new Error('Cannot fork from a tab whose conversation instance is missing')
      const idx = sourceInst.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return null

      try {
        const { tabId: newTabId } = await window.ion.createTab()
        const targetMessage = sourceInst.messages[idx]
        const messages: Message[] = sourceInst.messages.slice(0, idx).map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const restoredDenied = buildRestoredDenied(messages)

        const sourceDisplay = source.customTitle || source.title
        const baseMatch = sourceDisplay.match(/^(.+?)\s*\(\d+\)$/)
        const baseName = baseMatch ? baseMatch[1] : sourceDisplay
        const allTitles = get().tabs.map((t) => t.customTitle || t.title)
        let n = 1
        while (allTitles.includes(`${baseName} (${n})`)) n++
        const forkTitle = `${baseName} (${n})`

        const tab: TabState = {
          ...makeLocalTab(),
          id: newTabId,
          conversationId: null,
          forkedFromSessionId: source.conversationId,
          title: source.title,
          customTitle: forkTitle,
          workingDirectory: source.workingDirectory,
          hasChosenDirectory: source.hasChosenDirectory,
          additionalDirs: [...source.additionalDirs],
          pillColor: source.pillColor,
          pillIcon: source.pillIcon,
          // pendingInput stays on the tab (one-shot InputBar pre-fill); draftInput
          // is seeded onto the instance below.
          pendingInput: targetMessage.content,
        }
        // Carry the source instance's permission mode onto the new pane instance.
        const forkMode = effectivePermissionMode(source, get().conversationPanes)
        rInfo('session.fork', 'fork from message', { source_tab: tabId.slice(0, 8), new_tab: tab.id.slice(0, 8), count: messages.length, restored_denied: restoredDenied })
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({
            messages,
            messageCount: messages.length,
            modelOverride: sourceInst.modelOverride,
            permissionDenied: restoredDenied,
            draftInput: targetMessage.content,
            permissionMode: forkMode,
          })),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        window.ion.setPermissionMode(newTabId, forkMode, 'tab_create')
        return newTabId
      } catch {
        return null
      }
    },

    resumeSession: async (sessionId, title, projectPath, customTitle, encodedDir) => {
      const defaultDir = projectPath || get().staticInfo?.homePath || '~'
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
