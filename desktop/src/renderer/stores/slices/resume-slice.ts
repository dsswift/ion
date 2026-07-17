import type { TabState, Message } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'
import { makeMainPane, commitInstance, activeInstance, effectivePermissionMode, needsHistoryHydration } from '../conversation-instance'
import { lastPendingCardTool, type PendingCardMessage } from '../../../shared/pending-card'
import { mapSessionHistory, mapSessionMessage } from '../../../shared/session-message-mapper'
import { mapPersistedMessages, filterRestorablePersistedMessages } from '../persisted-message-map'
import { rInfo, rWarn } from '../../rendererLogger'

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

        let history: any[] = []
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            history = await window.ion.loadSession(sessionId, defaultDir, encodedDir || undefined)
            if (history.length > 0) break
          } catch (err) {
            rWarn('session.resume', 'loadSession attempt failed', { attempt: attempt + 1, error: String(err) })
          }
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
          }
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

    loadSkeletonMessages: async (tabId) => {
      // Externalized scrollback (schema v4): the instance's history lives in
      // a per-tab content file, not the engine store (renderer-only harness/
      // system rows never reach the engine). Load it once on first
      // activation; the engine-chain path below stays for count-only
      // instances whose rows ARE engine-reloadable.
      const pendingInst = activeInstance(get().conversationPanes, tabId)
      if (pendingInst?.externalContentStatus === 'pending') {
        const baseline = pendingInst.messages.length
        try {
          // Load the content file and the engine chain in parallel. The content
          // file holds renderer-only rows (harness/system) that are not in the
          // engine store. The engine chain is the authoritative source for
          // user/assistant/tool rows. Both are needed: a stale content file
          // (written after a session recycle that cleared the pane) misses the
          // real conversation rows, which the engine still has on disk.
          const tab = get().tabs.find((t) => t.id === tabId)
          const [content, chainHistory] = await Promise.all([
            window.ion.loadTabContent(tabId),
            tab?.conversationId
              ? window.ion.loadChainHistory([...(tab.historicalSessionIds ?? []), tab.conversationId])
                  .catch((err: unknown) => {
                    rWarn('session.restore', 'external content: engine chain load failed, using content file only', { tab_id: tabId.slice(0, 8), error: String(err) })
                    return [] as unknown[]
                  })
              : Promise.resolve([] as unknown[]),
          ])

          const restoredFromFile = content
            ? mapPersistedMessages(filterRestorablePersistedMessages(content.messages))
            : []

          // Engine chain is authoritative for user/assistant/tool rows.
          const engineRows = mapSessionHistory(chainHistory as Parameters<typeof mapSessionHistory>[0], nextMsgId)

          // Renderer-only rows (harness/system) exist only in the content file
          // and cannot be reloaded from the engine store. Supplement the engine
          // rows with these rather than using the full content file, so a stale
          // content file (missing real conversation rows) does not hide history.
          const rendererOnlyRows = restoredFromFile.filter(
            (m) => m.role === 'harness' || m.role === 'system',
          )

          // Merge and sort by timestamp so harness banners slot in
          // chronologically alongside the real conversation rows.
          const allRows = engineRows.length > 0
            ? [...engineRows, ...rendererOnlyRows].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
            : restoredFromFile

          rInfo('session.restore', 'external content hydrated', {
            tab_id: tabId.slice(0, 8),
            content_rows: restoredFromFile.length,
            engine_rows: engineRows.length,
            renderer_only_rows: rendererOnlyRows.length,
            merged_rows: allRows.length,
            baseline,
            missing: !content,
          })

          set((s) => ({
            conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => {
              // Keep live rows that streamed in during the async load (past
              // the baseline); everything before it is covered by the merged set.
              const liveTail = i.messages.slice(baseline)
              return {
                ...i,
                messages: [...allRows, ...liveTail],
                messageCount: allRows.length + liveTail.length,
                historyHydrated: true,
                externalContentStatus: content ? ('loaded' as const) : ('error' as const),
              }
            }),
          }))
        } catch (err) {
          rWarn('session.restore', 'external content load failed', { tab_id: tabId.slice(0, 8), error: String(err) })
          // Mark errored-but-hydrated so the tab is usable (count-only
          // rendering) and selectTab doesn't retry on every switch.
          set((s) => ({
            conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
              ...i,
              historyHydrated: true,
              externalContentStatus: 'error' as const,
            })),
          }))
        }
        return
      }

      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || !tab.conversationId) return
      // Precise hydration gate (needsHistoryHydration): the historyHydrated
      // marker, not message emptiness — live events append to skeleton panes
      // before the user opens them, and an emptiness check would skip the
      // history load, leaving only the live tail in the transcript.
      const inst = activeInstance(get().conversationPanes, tabId)
      if (!needsHistoryHydration(inst)) return
      // Messages already present are live-streamed arrivals on the skeleton.
      // Everything before this baseline is REPLACED by the history load (a
      // completed turn is persisted, so the history covers it); anything
      // appended during the async load is kept as the live tail. Known edge:
      // a turn still streaming at this instant loses its not-yet-persisted
      // partial text — the pre-hydration window is one IPC roundtrip.
      const baseline = inst!.messages.length

      try {
        // Load all historical + current session messages in a single
        // batch IPC roundtrip. The engine's loadChainHistory command
        // loads all session IDs in order and returns a flat array.
        // No retries — the engine is already running and the files
        // are on disk. The old code used 3 retries with exponential
        // backoff (2s, 4s) causing 6+ second waits on tab switch.
        const allSessionIds = [...tab.historicalSessionIds, tab.conversationId]
        const history = await window.ion.loadChainHistory(allSessionIds)

        // Shared mapper: internal rows filtered, marker rows converted to
        // system divider Messages (compaction/plan/steer).
        const allMessages: Message[] = mapSessionHistory(history, nextMsgId)

        // Restore permissionDenied from the last tool message (only if the
        // instance doesn't already have one from the persisted state)
        const currentInst = activeInstance(get().conversationPanes, tabId)
        let restoredDenied = currentInst?.permissionDenied ?? null
        if (!restoredDenied) {
          restoredDenied = buildRestoredDenied(allMessages)
        }

        rInfo('session.restore', 'skeleton messages hydrated', { tab_id: tabId.slice(0, 8), count: allMessages.length, baseline, restored_denied: !!restoredDenied })
        // Canonical ids make the live tail dedupable: a turn that completed
        // DURING the async load appears both in the history (entry-row id)
        // and in the tail (re-keyed at message_end / keyed by toolId), so
        // drop tail rows the history already contains.
        const historyIds = new Set(allMessages.map((m) => m.id))
        set((s) => ({
          conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => {
            const liveTail = i.messages.slice(baseline).filter((m) => !historyIds.has(m.id))
            return {
              ...i,
              // History first, then live messages that streamed in DURING the
              // load (past the baseline) — the pre-baseline live messages are
              // persisted turns the history already contains.
              messages: [...allMessages, ...liveTail],
              messageCount: allMessages.length + liveTail.length,
              historyHydrated: true,
              ...(restoredDenied ? { permissionDenied: restoredDenied } : {}),
            }
          }),
        }))
      } catch (err) {
        rWarn('session.restore', 'skeleton load failed', { tab_id: tabId.slice(0, 8), error: String(err) })
        // Mark hydrated with whatever live messages exist so the tab is
        // usable and selectTab doesn't retry the failing load on every switch.
        set((s) => ({
          conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
            ...i,
            messageCount: i.messages.length,
            historyHydrated: true,
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
