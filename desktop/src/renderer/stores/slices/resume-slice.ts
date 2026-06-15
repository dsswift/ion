import type { TabState, Message } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'
import { makeMainPane, commitInstance, activeInstance } from '../conversation-instance'
import { lastPendingCardTool, type PendingCardMessage } from '../../../shared/pending-card'

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Build a restored `permissionDenied` entry from a message history using the
 * shared pending-card rule (returns null when no card should be restored —
 * e.g. a trailing /clear divider or user message dismissed it). Single seam so
 * every fork/resume/rewind path in this slice applies the identical rule.
 */
function buildRestoredDenied(
  messages: readonly PendingCardMessage[],
): { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null {
  const found = lastPendingCardTool(messages)
  if (!found) return null
  return { tools: [{ toolName: found.toolName, toolUseId: found.toolId || 'restored', toolInput: parseToolInput(found.toolInput) }] }
}


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
          permissionMode: source.permissionMode,
          pillColor: source.pillColor,
          pillIcon: source.pillIcon,
        }
        // Seed the forked tab's `main` pane with the carried-over scrollback +
        // restored denial. modelOverride carries from the source instance.
        console.log(`[store] forkTab: source=${sourceTabId.slice(0, 8)} new=${tab.id.slice(0, 8)}:main msgs=${messages.length} restoredDenied=${restoredDenied ? 'yes' : 'no'}`)
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({
            messages,
            messageCount: messages.length,
            modelOverride: sourceInst.modelOverride,
            permissionDenied: restoredDenied,
          })),
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

      console.log(`[store] rewindToMessage: tabId=${tabId.slice(0, 8)}:main msgIdx=${idx} totalMsgs=${inst.messages.length} keepMsgs=${idx} oldSessionId=${oldSessionId?.slice(0, 16) ?? 'none'} historicalChainLen=${historicalSessionIds.length}`)

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
          permissionMode: source.permissionMode,
          pillColor: source.pillColor,
          pillIcon: source.pillIcon,
          // pendingInput stays on the tab (one-shot InputBar pre-fill); draftInput
          // is seeded onto the instance below.
          pendingInput: targetMessage.content,
        }
        console.log(`[store] forkFromMessage: source=${tabId.slice(0, 8)} new=${tab.id.slice(0, 8)}:main msgs=${messages.length} restoredDenied=${restoredDenied ? 'yes' : 'no'}`)
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({
            messages,
            messageCount: messages.length,
            modelOverride: sourceInst.modelOverride,
            permissionDenied: restoredDenied,
            draftInput: targetMessage.content,
          })),
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
        console.log(`[store] resumeSession: tab=${tab.id.slice(0, 8)}:main msgs=${messages.length} restoredDenied=${restoredDenied ? 'yes' : 'no'}`)
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

    loadSkeletonMessages: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || !tab.conversationId) return
      // Skeleton state lives on the active instance now: a persisted
      // messageCount > 0 with an empty messages array means not-yet-hydrated.
      // Already-loaded (messages present) tabs short-circuit.
      const inst = activeInstance(get().conversationPanes, tabId)
      if (!inst || inst.messages.length > 0) return

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

        // Restore permissionDenied from the last tool message (only if the
        // instance doesn't already have one from the persisted state)
        const currentInst = activeInstance(get().conversationPanes, tabId)
        let restoredDenied = currentInst?.permissionDenied ?? null
        if (!restoredDenied) {
          restoredDenied = buildRestoredDenied(allMessages)
        }

        console.log(`[loadSkeletonMessages] hydrated tab=${tabId.slice(0, 8)}:main msgs=${allMessages.length} restoredDenied=${restoredDenied ? 'yes' : 'no'}`)
        set((s) => ({
          conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
            ...i,
            messages: allMessages,
            messageCount: allMessages.length,
            ...(restoredDenied ? { permissionDenied: restoredDenied } : {}),
          })),
        }))
      } catch (err) {
        console.warn(`[loadSkeletonMessages] failed for tab ${tabId.slice(0, 8)}:main:`, err)
        // Hydrate with empty messages so the tab is usable
        set((s) => ({
          conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
            ...i,
            messages: [],
            messageCount: 0,
          })),
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
        console.log(`[store] resumeSessionWithChain: tab=${tab.id.slice(0, 8)}:main msgs=${allMessages.length} restoredDenied=${restoredDenied ? 'yes' : 'no'}`)
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
