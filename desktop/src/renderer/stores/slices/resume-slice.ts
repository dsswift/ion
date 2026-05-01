import type { TabState, Message } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'

export function createResumeSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    forkTab: async (sourceTabId) => {
      const source = get().tabs.find((t) => t.id === sourceTabId)
      if (!source || !source.conversationId) return null
      try {
        const { tabId } = await window.ion.createTab()

        const messages: Message[] = source.messages.map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const lastToolMsg = [...messages].reverse().find((m) => m.toolName)
        const restoredDenied = (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion')
          ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored' }] }
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
      const idx = tab.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return

      const targetMessage = tab.messages[idx]
      const oldSessionId = tab.conversationId
      const historicalSessionIds = oldSessionId
        ? [...tab.historicalSessionIds, oldSessionId]
        : [...tab.historicalSessionIds]

      const rewoundMessages = tab.messages.slice(0, idx)
      const lastToolMsg = [...rewoundMessages].reverse().find((m) => m.toolName)
      const restoredDenied = (lastToolMsg?.toolName === 'ExitPlanMode' || lastToolMsg?.toolName === 'AskUserQuestion')
        ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored' }] }
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
          ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored' }] }
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
        const messages: Message[] = history.map((m) => ({
          id: nextMsgId(),
          role: m.role as Message['role'],
          content: m.content,
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
          ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored' }] }
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

    resumeSessionWithChain: async (sessionId, historicalSessionIds, title, projectPath, customTitle, encodedDir) => {
      const defaultDir = projectPath || get().staticInfo?.homePath || '~'
      try {
        const { tabId } = await window.ion.createTab()

        const allMessages: Message[] = []
        for (const histId of historicalSessionIds) {
          const history = await window.ion.loadSession(histId, defaultDir, encodedDir || undefined).catch(() => [])
          for (const m of history) {
            allMessages.push({
              id: nextMsgId(),
              role: m.role as Message['role'],
              content: m.content,
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
        for (const m of currentHistory) {
          allMessages.push({
            id: nextMsgId(),
            role: m.role as Message['role'],
            content: m.content,
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
          ? { tools: [{ toolName: lastToolMsg.toolName, toolUseId: 'restored' }] }
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
