import type { TabState, Message } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

export function createResumeSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    forkTab: async (sourceTabId) => {
      const source = get().tabs.find((t) => t.id === sourceTabId)
      if (!source || !source.conversationId) return null
      if (!source.messages) throw new Error('Cannot fork a skeleton tab without loaded messages')
      try {
        const { tabId } = await window.ion.createTab()

        const messages: Message[] = source.messages.map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const lastToolMsg = [...messages].reverse().find((m) => m.toolName)
        const restoredDenied = (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion')
          ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored', toolInput: parseToolInput(lastToolMsg.toolInput) }] }
          : null

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
          permissionMode: source.permissionMode,
          pillColor: source.pillColor,
          pillIcon: source.pillIcon,
          messages,
          permissionDenied: restoredDenied,
        }
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          isExpanded: true,
        }))
        window.ion.setPermissionMode(tabId, tab.permissionMode, 'tab_create')
        return tabId
      } catch {
        return null
      }
    },

    rewindToMessage: (tabId, messageId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      if (!tab.messages) throw new Error('Cannot rewind a skeleton tab without loaded messages')
      const idx = tab.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return

      const targetMessage = tab.messages[idx]
      const oldSessionId = tab.conversationId
      const historicalSessionIds = oldSessionId
        ? [...tab.historicalSessionIds, oldSessionId]
        : [...tab.historicalSessionIds]

      console.log(`[store] rewindToMessage: tabId=${tabId.slice(0, 8)} msgIdx=${idx} totalMsgs=${tab.messages.length} keepMsgs=${idx} oldSessionId=${oldSessionId?.slice(0, 16) ?? 'none'} historicalChainLen=${historicalSessionIds.length}`)

      const rewoundMessages = tab.messages.slice(0, idx)
      const lastToolMsg = [...rewoundMessages].reverse().find((m) => m.toolName)
      const restoredDenied = (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion')
        ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored', toolInput: parseToolInput(lastToolMsg.toolInput) }] }
        : null

      window.ion.resetTabSession(tabId)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                messages: rewoundMessages,
                conversationId: null,
                historicalSessionIds,
                forkedFromSessionId: oldSessionId,
                lastResult: null,
                currentActivity: '',
                permissionQueue: [],
                permissionDenied: restoredDenied,
                queuedPrompts: [],
                pendingInput: targetMessage.content,
                draftInput: targetMessage.content,
              }
            : t
        ),
      }))
    },

    forkFromMessage: async (tabId, messageId) => {
      const source = get().tabs.find((t) => t.id === tabId)
      if (!source) return null
      if (!source.messages) throw new Error('Cannot fork from a skeleton tab without loaded messages')
      const idx = source.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return null

      try {
        const { tabId: newTabId } = await window.ion.createTab()
        const targetMessage = source.messages[idx]
        const messages: Message[] = source.messages.slice(0, idx).map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const lastToolMsg = [...messages].reverse().find((m) => m.toolName)
        const restoredDenied = (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion')
          ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored', toolInput: parseToolInput(lastToolMsg.toolInput) }] }
          : null

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
          permissionMode: source.permissionMode,
          pillColor: source.pillColor,
          pillIcon: source.pillIcon,
          messages,
          permissionDenied: restoredDenied,
          pendingInput: targetMessage.content,
          draftInput: targetMessage.content,
        }
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          isExpanded: true,
        }))
        window.ion.setPermissionMode(newTabId, tab.permissionMode, 'tab_create')
        return newTabId
      } catch {
        return null
      }
    },

    resumeSession: async (sessionId, title, projectPath, customTitle, encodedDir) => {
      const defaultDir = projectPath || get().staticInfo?.homePath || '~'
      try {
        const { tabId } = await window.ion.createTab()

        let history: any[] = []
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            history = await window.ion.loadSession(sessionId, defaultDir, encodedDir || undefined)
            if (history.length > 0) break
          } catch (err) {
            console.warn(`[resumeSession] loadSession attempt ${attempt + 1} failed:`, err)
          }
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
          }
        }
        const messages: Message[] = history.filter((m: any) => !m.internal).map((m) => ({
          id: nextMsgId(),
          role: m.role as Message['role'],
          content: m.content || '',
          toolName: m.toolName,
          toolId: m.toolId,
          toolInput: m.toolInput,
          toolStatus: m.toolName ? 'completed' as const : undefined,
          userExecuted: m.userExecuted,
          attachments: m.attachments,
          timestamp: m.timestamp,
        }))

        const lastToolMsg = [...messages].reverse().find((m) => m.toolName)
        const restoredDenied = (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion')
          ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored', toolInput: parseToolInput(lastToolMsg.toolInput) }] }
          : null

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
          messages,
          permissionDenied: restoredDenied,
          groupId,
        }
        set((s) => ({
          tabs: [...s.tabs, tab],
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
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          isExpanded: true,
        }))
        return tab.id
      }
    },

    loadSkeletonMessages: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || tab.messages !== null || !tab.conversationId) return

      try {
        // Load all historical + current session messages in a single
        // batch IPC roundtrip. The engine's loadChainHistory command
        // loads all session IDs in order and returns a flat array.
        // No retries — the engine is already running and the files
        // are on disk. The old code used 3 retries with exponential
        // backoff (2s, 4s) causing 6+ second waits on tab switch.
        const allSessionIds = [...tab.historicalSessionIds, tab.conversationId]
        const history = await window.ion.loadChainHistory(allSessionIds)

        const allMessages: Message[] = history
          .filter((m: any) => !m.internal)
          .map((m: any) => ({
            id: nextMsgId(),
            role: m.role as Message['role'],
            content: m.content || '',
            toolName: m.toolName,
            toolId: m.toolId,
            toolInput: m.toolInput,
            toolStatus: m.toolName ? 'completed' as const : undefined,
            userExecuted: m.userExecuted,
            attachments: m.attachments,
            timestamp: m.timestamp,
          }))

        // Restore permissionDenied from the last tool message (only if tab
        // doesn't already have one from the persisted state)
        const currentTab = get().tabs.find((t) => t.id === tabId)
        let restoredDenied = currentTab?.permissionDenied ?? null
        if (!restoredDenied) {
          const lastToolMsg = [...allMessages].reverse().find((m) => m.toolName)
          if (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion') {
            restoredDenied = { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored', toolInput: parseToolInput(lastToolMsg.toolInput) }] }
          }
        }

        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  messages: allMessages,
                  messageCount: allMessages.length,
                  ...(restoredDenied ? { permissionDenied: restoredDenied } : {}),
                }
              : t
          ),
        }))
      } catch (err) {
        console.warn(`[loadSkeletonMessages] failed for tab ${tabId.slice(0, 8)}:`, err)
        // Hydrate with empty messages so the tab is usable
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId && t.messages === null
              ? { ...t, messages: [], messageCount: 0 }
              : t
          ),
        }))
      }
    },

    resumeSessionWithChain: async (sessionId, historicalSessionIds, title, projectPath, customTitle, encodedDir) => {
      const defaultDir = projectPath || get().staticInfo?.homePath || '~'
      try {
        const { tabId } = await window.ion.createTab()

        const allMessages: Message[] = []
        for (const histId of historicalSessionIds) {
          const history = await window.ion.loadSession(histId, defaultDir, encodedDir || undefined).catch(() => [])
          for (const m of history.filter((h: any) => !h.internal)) {
            allMessages.push({
              id: nextMsgId(),
              role: m.role as Message['role'],
              content: m.content || '',
              toolName: m.toolName,
              toolId: m.toolId,
              toolInput: m.toolInput,
              toolStatus: m.toolName ? 'completed' as const : undefined,
              userExecuted: m.userExecuted,
              attachments: m.attachments,
              timestamp: m.timestamp,
            })
          }
        }

        const currentHistory = await window.ion.loadSession(sessionId, defaultDir, encodedDir || undefined).catch(() => [])
        for (const m of currentHistory.filter((h: any) => !h.internal)) {
          allMessages.push({
            id: nextMsgId(),
            role: m.role as Message['role'],
            content: m.content || '',
            toolName: m.toolName,
            toolId: m.toolId,
            toolInput: m.toolInput,
            toolStatus: m.toolName ? 'completed' as const : undefined,
            userExecuted: m.userExecuted,
            attachments: m.attachments,
            timestamp: m.timestamp,
          })
        }

        const lastToolMsg = [...allMessages].reverse().find((m) => m.toolName)
        const restoredDenied = (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion')
          ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored', toolInput: parseToolInput(lastToolMsg.toolInput) }] }
          : null

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
          messages: allMessages,
          permissionDenied: restoredDenied,
          groupId,
        }
        set((s) => ({
          tabs: [...s.tabs, tab],
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
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          isExpanded: true,
        }))
        return tab.id
      }
    },
  }
}
