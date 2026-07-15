import { useEffect } from 'react'
import type { Message, TabState } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { setSavedBuffer } from '../components/TerminalInstance'
import { restoreConversationTab } from './useTabRestoration-engine'
import { makeLocalTab } from '../stores/session-store-helpers'
import { makeMainPane, commitInstance, activeInstance } from '../stores/conversation-instance'
import { lastPendingCardTool } from '../../shared/pending-card'
import { mapSessionHistory } from '../../shared/session-message-mapper'
import { parseToolInput, isSkeletonTab, normalizeLegacyTabFields, readMainInstance, reassertRestoredPlanMode, orderSessionCandidates, startSessionsSequentially } from './useTabRestoration-helpers'
import { tabHasExtensions, persistedTabHasExtensions } from '../../shared/tab-predicates'
import { rDebug, rInfo, rWarn } from '../rendererLogger'

/**
 * Bootstrap effect run once at app start. Initializes static info, restores
 * any persisted tabs (sessions, engine, terminal-only, sessionless), reapplies
 * historical messages, restores editor and panel geometry, and falls back to
 * a single blank tab when no persisted state exists.
 *
 * Extracted from App.tsx to keep the root component under the file-size cap.
 */
export function useTabRestoration() {
  useEffect(() => {
    let aborted = false
    useSessionStore.getState().initStaticInfo().then(async () => {
      if (aborted) return
      useSessionStore.setState({ initProgress: 'Loading saved tabs…' })
      const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'

      // Try restoring saved tabs
      const saved = await window.ion.loadTabs().catch(() => null)
      if (saved && saved.tabs && saved.tabs.length > 0) {
        // Normalize loaded tabs to the unified conversationPane shape in memory
        // (handles both the isEngine rename and the split→unified persisted
        // shape; idempotent for already-migrated files). Restoration then reads
        // conversation state from conversationPane uniformly.
        saved.tabs = normalizeLegacyTabFields(saved.tabs)
        useSessionStore.setState({ initProgress: `Restoring ${saved.tabs.length} tabs…` })
        // Gate persistence during the restore loop. Each per-tab setState fires the
        // persist subscriber, producing ~N partial saves before all tabs are loaded.
        // These partial saves trip the GUARD (on-disk has N tabs, incoming has 1..N-1)
        // and generate ~N "refusing save" rejections. Setting rehydrating=true makes
        // the subscriber early-return for the entire restore window; it is cleared
        // alongside tabsReady=true after the loop completes. The on-disk tab-count
        // GUARD remains as the backstop for any other callers.
        useSessionStore.setState({ rehydrating: true })
        // Restore each saved tab.
        // persistedTabHasExtensions: ROUTING (IPC path), not content-vs-skeleton.
        // Content-vs-skeleton is data-driven in serializeConversationPane (WI-005).
        // Legacy hasEngineExtension fallback is a one-time migration READ only.
        const restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }> = []
        for (let i = 0; i < saved.tabs.length; i++) {
          useSessionStore.setState({ initProgress: `Restoring tab ${i + 1} of ${saved.tabs.length}…` })
          const st = saved.tabs[i]
          if (st.conversationId && !persistedTabHasExtensions(st)) {
            // Determine if this is the active tab (loads messages eagerly)
            const isActiveTab = (saved.activeTabIndex !== undefined && saved.activeTabIndex !== null && i === saved.activeTabIndex) ||
                                (!!(saved.activeSessionId && st.conversationId === saved.activeSessionId))

            // Restore worktree info if present (verify path still exists)
            let restoredWorktree = st.worktree || null
            if (restoredWorktree) {
              try {
                await window.ion.fsReadDir(restoredWorktree.worktreePath)
                // Directory exists, keep the worktree info
              } catch {
                // Worktree was cleaned up externally
                restoredWorktree = null
              }
            }

            if (isActiveTab) {
              // Active tab: load messages eagerly via resumeSession
              const tabId = await useSessionStore.getState().resumeSession(
                st.conversationId,
                st.title,
                st.workingDirectory,
              )
              restoredTabIds.push({ tabId, sessionId: st.conversationId, index: i })

              // Patch extra per-tab settings that resumeSession doesn't handle.
              // modelOverride / draftInput / permissionDenied / planFilePath /
              // permissionMode moved off TabState onto the active `main`
              // ConversationInstance, so they are layered onto the existing pane
              // (seeded eagerly at tab creation / by resumeSession) via
              // commitInstance in the same set, rather than written to the tab object.
              useSessionStore.setState((s) => {
                const main = readMainInstance(st)
                // permissionMode: prefer instance-persisted value; fall back to
                // legacy tab-level field for tabs saved before WI-002.
                const restoredMode: 'auto' | 'plan' = main?.permissionMode ?? (st as any).permissionMode ?? 'auto'
                const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
                  ...inst,
                  modelOverride: main?.modelOverride || null,
                  draftInput: main?.draftInput ?? '',
                  permissionMode: restoredMode,
                  // Persisted permissionDenied is authoritative over resumeSession reconstruction
                  ...(main?.permissionDenied ? { permissionDenied: main.permissionDenied } : {}),
                  ...(main?.planFilePath ? { planFilePath: main.planFilePath } : {}),
                }))
                return {
                  conversationPanes,
                  tabs: s.tabs.map((t) =>
                    t.id === tabId
                      ? {
                          ...t,
                          customTitle: st.customTitle || null,
                          hasChosenDirectory: st.hasChosenDirectory,
                          additionalDirs: st.additionalDirs,
                          bashResults: st.bashResults || [],
                          pillColor: st.pillColor || null,
                          pillIcon: st.pillIcon || null,
                          worktree: restoredWorktree,
                          historicalSessionIds: st.historicalSessionIds || [],
                          lastKnownSessionId: st.lastKnownSessionId || null,
                          groupId: st.groupId || null,
                          groupPinned: st.groupPinned ?? false,
                          contextTokens: st.contextTokens || null,
                          contextWindow: st.contextWindow || null,
                          queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
                          lastMessagePreview: st.lastMessagePreview || null,
                          lastEventAt: st.lastEventAt ?? null,
                          // If worktree is valid, restore workingDirectory to worktree path
                          // If worktree was cleaned up, fall back to original repo path
                          ...(restoredWorktree
                            ? { workingDirectory: restoredWorktree.worktreePath }
                            : st.worktree ? { workingDirectory: st.worktree.repoPath } : {}),
                        }
                      : t
                  ),
                }
              })
              reassertRestoredPlanMode(tabId, readMainInstance(st), (st as any).permissionMode)
              if (st.draftInput) rDebug('restore', 'draft for tab', { tab_id: tabId.slice(0, 8), count: st.draftInput.length })
            } else {
              // Non-active tab: create skeleton tab whose `main` instance has
              // empty messages + a persisted messageCount (lazy load)
              let tabId: string
              try {
                const res = await window.ion.createTab()
                tabId = res.tabId
              } catch {
                tabId = crypto.randomUUID()
              }
              restoredTabIds.push({ tabId, sessionId: st.conversationId, index: i })

              const tab: TabState = {
                ...makeLocalTab(),
                id: tabId,
                conversationId: st.conversationId,
                lastKnownSessionId: st.lastKnownSessionId || st.conversationId,
                historicalSessionIds: st.historicalSessionIds || [],
                title: st.title || 'Resumed Session',
                customTitle: st.customTitle || null,
                workingDirectory: st.workingDirectory,
                hasChosenDirectory: st.hasChosenDirectory,
                additionalDirs: st.additionalDirs,
                bashResults: st.bashResults || [],
                pillColor: st.pillColor || null,
                pillIcon: st.pillIcon || null,
                forkedFromSessionId: st.forkedFromSessionId || null,
                worktree: restoredWorktree,
                groupId: st.groupId || null,
                groupPinned: st.groupPinned ?? false,
                contextTokens: st.contextTokens || null,
                contextWindow: st.contextWindow || null,
                queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
                lastMessagePreview: st.lastMessagePreview || null,
                lastEventAt: st.lastEventAt ?? null,
                // If worktree is valid, restore workingDirectory to worktree path
                // If worktree was cleaned up, fall back to original repo path
                ...(restoredWorktree
                  ? { workingDirectory: restoredWorktree.worktreePath }
                  : st.worktree ? { workingDirectory: st.worktree.repoPath } : {}),
              }

              // Skeleton (lazy-load) tab: seed the `main` instance with empty
              // messages but the persisted messageCount so blank-tab detection
              // and lazy-load gating still work. messages / messageCount /
              // modelOverride / draftInput / permissionDenied / planFilePath
              // moved off TabState onto the instance — restored here via the
              // makeMainPane overrides and written into conversationPanes in the same set.
              const main = readMainInstance(st)
              // permissionMode: prefer instance-persisted; fall back to legacy tab-level field.
              const skeletonMode: 'auto' | 'plan' = main?.permissionMode ?? (st as any).permissionMode ?? 'auto'
              const pane = makeMainPane({
                messages: [],
                messageCount: main?.messageCount ?? 0,
                modelOverride: main?.modelOverride || null,
                draftInput: main?.draftInput ?? '',
                permissionDenied: main?.permissionDenied ?? null,
                planFilePath: main?.planFilePath ?? null,
                permissionMode: skeletonMode,
              })

              useSessionStore.setState((s) => {
                const conversationPanes = new Map(s.conversationPanes)
                conversationPanes.set(tabId, pane)
                return { tabs: [...s.tabs, tab], conversationPanes }
              })
              reassertRestoredPlanMode(tabId, main, (st as any).permissionMode)
              if (main?.draftInput) rDebug('restore', 'skeleton tab draft', { tab_id: tabId.slice(0, 8), count: main.draftInput.length })
            }
          } else if (persistedTabHasExtensions(st)) {
            await restoreConversationTab(st, restoredTabIds, i)
          } else if (st.isTerminalOnly) {
            // Terminal-only tab
            const tabId = await useSessionStore.getState().createTerminalTab()
            restoredTabIds.push({ tabId, sessionId: null, index: i })

            useSessionStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      customTitle: st.customTitle || null,
                      workingDirectory: st.workingDirectory,
                      hasChosenDirectory: st.hasChosenDirectory,
                      pillColor: st.pillColor || null,
                      pillIcon: st.pillIcon || 'Terminal',
                      groupId: st.groupId || null,
                      groupPinned: st.groupPinned ?? false,
                      // draftInput moved to the conversation instance and
                      // terminal-only tabs have no conversation instance, so
                      // there is nothing to seed here. The persisted value is
                      // still logged below for parity with the other paths.
                      lastMessagePreview: st.lastMessagePreview || null,
                      lastEventAt: st.lastEventAt ?? null,
                    }
                  : t
              ),
            }))
            if (st.draftInput) rDebug('restore', 'draft for terminal tab', { tab_id: tabId.slice(0, 8), count: st.draftInput.length })

            // Restore terminal instances from persisted state
            if (st.terminalInstances && st.terminalInstances.length > 0) {
              const panes = new Map(useSessionStore.getState().terminalPanes)
              panes.set(tabId, {
                instances: st.terminalInstances,
                activeInstanceId: st.terminalInstances[0].id,
              })
              useSessionStore.setState({ terminalPanes: panes })
              // Pre-populate saved buffers for history restore
              if (st.terminalBuffers) {
                for (const inst of st.terminalInstances) {
                  const buf = st.terminalBuffers[inst.id]
                  if (buf) setSavedBuffer(`${tabId}:${inst.id}`, buf)
                }
              }
            }
          } else {
            // Sessionless tab (e.g. has editor state but no messages sent yet)
            const tabId = await useSessionStore.getState().createTabInDirectory(st.workingDirectory, false, true)
            restoredTabIds.push({ tabId, sessionId: null, index: i })

            // Sessionless tab has no messages yet, but modelOverride /
            // draftInput moved off TabState onto the `main` instance. Seed
            // the pane with those overrides (empty scrollback) and write it
            // into conversationPanes in the same set as the tab-level patch.
            const sessionlessMain = readMainInstance(st)
            const sessionlessMode: 'auto' | 'plan' = sessionlessMain?.permissionMode ?? (st as any).permissionMode ?? 'auto'
            const sessionlessPane = makeMainPane({
              modelOverride: sessionlessMain?.modelOverride || null,
              draftInput: sessionlessMain?.draftInput ?? '',
              permissionMode: sessionlessMode,
            })

            useSessionStore.setState((s) => {
              const conversationPanes = new Map(s.conversationPanes)
              conversationPanes.set(tabId, sessionlessPane)
              return {
                conversationPanes,
                tabs: s.tabs.map((t) =>
                  t.id === tabId
                    ? {
                        ...t,
                        customTitle: st.customTitle || null,
                        hasChosenDirectory: st.hasChosenDirectory,
                        additionalDirs: st.additionalDirs,
                        pillColor: st.pillColor || null,
                        pillIcon: st.pillIcon || null,
                        forkedFromSessionId: st.forkedFromSessionId || null,
                        worktree: st.worktree || null,
                        historicalSessionIds: st.historicalSessionIds || [],
                        lastKnownSessionId: st.lastKnownSessionId || null,
                        groupId: st.groupId || null,
                        groupPinned: st.groupPinned ?? false,
                        contextTokens: st.contextTokens || null,
                        contextWindow: st.contextWindow || null,
                        queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
                        lastMessagePreview: st.lastMessagePreview || null,
                        lastEventAt: st.lastEventAt ?? null,
                      }
                    : t
                ),
              }
            })
            reassertRestoredPlanMode(tabId, sessionlessMain, (st as any).permissionMode)
            if (sessionlessMain?.draftInput) rDebug('restore', 'draft for sessionless tab', { tab_id: tabId.slice(0, 8), count: sessionlessMain.draftInput.length })
          }
        }

        // Eager durable session start for restored NORMAL (non-engine) tabs
        // that have a conversationId. Staggered: the active tab starts first
        // (what the user sees), then remaining tabs start sequentially so the
        // shared engine daemon's dispatch goroutine isn't overwhelmed by a
        // simultaneous burst. Ordering + sequential start are pure/structural
        // helpers so the no-burst contract is unit-pinned (see
        // useTabRestoration-helpers.ts).
        const sessionCandidates = restoredTabIds.filter(({ index }) => {
          const st = saved.tabs[index]
          return st && !persistedTabHasExtensions(st) && !st.isTerminalOnly && st.conversationId
        })
        const activeIdx = saved.activeTabIndex ?? -1
        const activeFirst = orderSessionCandidates(sessionCandidates, activeIdx)
        await startSessionsSequentially(activeFirst, async ({ tabId, index }) => {
          const st = saved.tabs[index]
          // Read permission mode from the restored conversation instance (the
          // authoritative location post-WI-002). Fall back to the legacy
          // tab-level field for tabs persisted before WI-002.
          const restoredMain = readMainInstance(st)
          const sessionPermMode: 'auto' | 'plan' = restoredMain?.permissionMode ?? (st as any).permissionMode ?? 'auto'
          try {
            const res = await window.ion.ensureEngineSession({
              tabId,
              workingDirectory: st.workingDirectory,
              conversationId: st.conversationId!,
              permissionMode: sessionPermMode,
            })
            if (res?.ok) {
              rInfo('restore', 'eager session started', { tab_id: tabId.slice(0, 8), conversation_id: st.conversationId?.slice(0, 24) ?? '' })
            } else {
              rWarn('restore', 'eager session start failed', { tab_id: tabId.slice(0, 8), error: res?.error ?? 'unknown' })
            }
          } catch (err: any) {
            rWarn('restore', 'eager session start threw', { tab_id: tabId.slice(0, 8), error: err?.message ?? String(err) })
          }
        })

        useSessionStore.setState({ initProgress: 'Loading history…' })
        // Load historical session messages for tabs that have them
        // Skip skeleton tabs — their history loads on-demand via loadSkeletonMessages
        for (const { tabId, index } of restoredTabIds) {
          if (isSkeletonTab(useSessionStore.getState().conversationPanes, tabId)) continue

          const st = saved.tabs[index]
          const historicalIds = st.historicalSessionIds || []
          if (historicalIds.length > 0) {
            const allHistoricalMessages: Message[] = []
            for (const hid of historicalIds) {
              const history = await window.ion.loadSession(hid, st.workingDirectory).catch(() => [])
              const msgs = mapSessionHistory(history, () => crypto.randomUUID())
              allHistoricalMessages.push(...msgs)
            }

            if (allHistoricalMessages.length > 0) {
              // If tab has no active session and combined messages end with
              // ExitPlanMode/AskUserQuestion, restore the plan card so the
              // user can re-implement without hunting through history.
              // Messages + permissionDenied now live on the `main` instance.
              const tab = useSessionStore.getState().tabs.find((t) => t.id === tabId)
              const inst = activeInstance(useSessionStore.getState().conversationPanes, tabId)
              const combinedMessages = [...allHistoricalMessages, ...(inst?.messages ?? [])]
              let restoredDenied = inst?.permissionDenied ?? null
              if (!restoredDenied && !tab?.conversationId) {
                // Shared pending-card rule: restore only when the last
                // AskUserQuestion / ExitPlanMode is still outstanding (no
                // trailing /clear divider, no trailing user message).
                const found = lastPendingCardTool(combinedMessages)
                if (found) {
                  restoredDenied = { tools: [{ toolName: found.toolName, toolUseId: found.toolId || 'restored', toolInput: parseToolInput(found.toolInput) }] }
                } else {
                  rDebug('restore', 'no pending card restored', { tab_id: tabId.slice(0, 8) })
                }
              }

              // Prepend historical messages onto the instance scrollback and
              // (optionally) seed the restored denial card — both on the
              // `main` instance via commitInstance in a single set.
              useSessionStore.setState((s) => ({
                conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
                  ...i,
                  messages: [...allHistoricalMessages, ...i.messages],
                  ...(restoredDenied ? { permissionDenied: restoredDenied } : {}),
                })),
              }))
            }
          }
        }

        // Fallback: recover messages from lastKnownSessionId when both
        // conversationId and historicalSessionIds are empty
        // Skip skeleton tabs — they defer all message loading to on-demand
        for (const { tabId, index } of restoredTabIds) {
          if (isSkeletonTab(useSessionStore.getState().conversationPanes, tabId)) continue

          const st = saved.tabs[index]
          const historicalIds = st.historicalSessionIds || []
          if (!st.conversationId && historicalIds.length === 0 && st.lastKnownSessionId) {
            const history = await window.ion.loadSession(st.lastKnownSessionId, st.workingDirectory).catch(() => [])
            if (history.length > 0) {
              const msgs = mapSessionHistory(history, () => crypto.randomUUID())
              // Prepend recovered messages onto the `main` instance scrollback.
              useSessionStore.setState((s) => ({
                conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
                  ...i,
                  messages: [...msgs, ...i.messages],
                })),
              }))
            }
          }
        }

        // Restore terminal pane instances for non-terminal-only tabs
        for (const { tabId, index } of restoredTabIds) {
          const st = saved.tabs[index]
          if (!st.isTerminalOnly && st.terminalInstances && st.terminalInstances.length > 0) {
            const panes = new Map(useSessionStore.getState().terminalPanes)
            panes.set(tabId, {
              instances: st.terminalInstances,
              activeInstanceId: st.terminalInstances[0].id,
            })
            useSessionStore.setState({ terminalPanes: panes })
            // Pre-populate saved buffers for history restore
            if (st.terminalBuffers) {
              for (const inst of st.terminalInstances) {
                const buf = st.terminalBuffers[inst.id]
                if (buf) setSavedBuffer(`${tabId}:${inst.id}`, buf)
              }
            }
          }
        }

        // Set active tab by index (handles both session and sessionless tabs)
        if (typeof saved.activeTabIndex === 'number') {
          const activeEntry = restoredTabIds.find((r) => r.index === saved.activeTabIndex)
          if (activeEntry) {
            useSessionStore.setState({ activeTabId: activeEntry.tabId })
          }
        } else if (saved.activeSessionId) {
          // Backwards compat: fall back to session ID matching
          const activeEntry = restoredTabIds.find((r) => r.sessionId === saved.activeSessionId)
          if (activeEntry) {
            useSessionStore.setState({ activeTabId: activeEntry.tabId })
          }
        }

        // Remove the initial blank tab created by store constructor
        const initialTabId = useSessionStore.getState().tabs[0]?.id
        const isInitialBlank = initialTabId && !restoredTabIds.some((r) => r.tabId === initialTabId)
        if (isInitialBlank) {
          useSessionStore.setState((s) => ({
            tabs: s.tabs.filter((t) => t.id !== initialTabId),
          }))
        }

        useSessionStore.setState({ initProgress: 'Restoring workspace…' })
        // Restore editor states (per-directory)
        if (saved.editorStates) {
          const restoredEditorStates = new Map<string, any>()
          for (const [dir, dirState] of Object.entries(saved.editorStates as Record<string, any>)) {
            if (dirState && dirState.files && dirState.files.length > 0) {
              let fileIdCounter = 0
              const files = dirState.files.map((f: any) => ({
                id: `restored-${dir}-${fileIdCounter++}`,
                filePath: f.filePath,
                fileName: f.fileName,
                content: f.content || '',
                savedContent: f.savedContent || '',
                isDirty: f.isDirty || false,
                isReadOnly: f.isReadOnly || false,
                isPreview: f.isPreview || false,
              }))
              // Restore active file by saved index (IDs are regenerated on each restore)
              const savedIdx = typeof dirState.activeFileIndex === 'number' ? dirState.activeFileIndex : 0
              const activeIdx = savedIdx >= 0 && savedIdx < files.length ? savedIdx : 0
              const activeFileId = files.length > 0 ? files[activeIdx].id : null
              restoredEditorStates.set(dir, { activeFileId, files })
            }
          }
          if (restoredEditorStates.size > 0) {
            useSessionStore.setState({ fileEditorStates: restoredEditorStates })
          }
        }

        // Restore which directories had the file editor open
        if (saved.editorOpenDirs && saved.editorOpenDirs.length > 0) {
          useSessionStore.setState({ fileEditorOpenDirs: new Set(saved.editorOpenDirs) })
        } else if (saved.editorOpenSessionIds && saved.editorOpenSessionIds.length > 0) {
          // Backwards compat: map old per-tab indices to directories
          const openIndexSet = new Set(saved.editorOpenSessionIds)
          const dirs = new Set<string>()
          for (const r of restoredTabIds) {
            if (openIndexSet.has(r.index)) {
              const st = saved.tabs[r.index]
              if (st?.workingDirectory) dirs.add(st.workingDirectory)
            }
          }
          if (dirs.size > 0) {
            useSessionStore.setState({ fileEditorOpenDirs: dirs })
          }
        }

        // Restore global editor geometry (clamped to current screen)
        if (saved.editorGeometry) {
          const g = saved.editorGeometry
          const clampedGeo = {
            x: Math.max(-200, Math.min(window.innerWidth - 100, g.x)),
            y: Math.max(0, Math.min(window.innerHeight - 32, g.y)),
            w: Math.max(400, g.w),
            h: Math.max(280, g.h),
          }
          useSessionStore.setState({ editorGeometry: clampedGeo })
        }

        // Restore global plan preview geometry (clamped to current screen)
        if (saved.planGeometry) {
          const g = saved.planGeometry
          const clampedGeo = {
            x: Math.max(-200, Math.min(window.innerWidth - 100, g.x)),
            y: Math.max(0, Math.min(window.innerHeight - 32, g.y)),
            w: Math.max(280, g.w),
            h: Math.max(180, g.h),
          }
          useSessionStore.setState({ planGeometry: clampedGeo })
        }

        // Restore global agent detail popup geometry (clamped to current screen)
        if (saved.agentDetailGeometry) {
          const g = saved.agentDetailGeometry
          const clampedGeo = {
            x: Math.max(-200, Math.min(window.innerWidth - 100, g.x)),
            y: Math.max(0, Math.min(window.innerHeight - 32, g.y)),
            w: Math.max(280, g.w),
            h: Math.max(180, g.h),
          }
          useSessionStore.setState({ agentDetailGeometry: clampedGeo })
        }

        // Restore expanded/collapsed state, or fall back to setting
        const restoredExpanded = typeof saved.isExpanded === 'boolean'
          ? saved.isExpanded
          : usePreferencesStore.getState().expandOnTabSwitch
        useSessionStore.setState({ isExpanded: restoredExpanded, tabsReady: true, rehydrating: false, initProgress: null })
        return
      }

      // No saved tabs -- fall through to blank tab behavior
      const tab = useSessionStore.getState().tabs[0]
      if (tab) {
        const defaultBase = usePreferencesStore.getState().defaultBaseDirectory
        const startDir = defaultBase || homeDir
        const hasChosen = !!defaultBase
        useSessionStore.setState((s) => ({
          tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, workingDirectory: startDir, hasChosenDirectory: hasChosen } : t)),
        }))
        useSessionStore.setState({ initProgress: 'Creating new tab…' })
        const registerInitialTab = async (retries = 5): Promise<void> => {
          for (let i = 0; i < retries; i++) {
            try {
              const { tabId } = await window.ion.createTab()
              useSessionStore.setState((s) => ({
                tabs: s.tabs.map((t, idx) => (idx === 0 ? { ...t, id: tabId } : t)),
                activeTabId: tabId,
                tabsReady: true,
                rehydrating: false,
                initProgress: null,
              }))
              return
            } catch {
              if (i < retries - 1) await new Promise((r) => setTimeout(r, 500))
            }
          }
          // All retries failed — still set tabsReady so UI isn't stuck forever
          useSessionStore.setState({ tabsReady: true, rehydrating: false, initProgress: null })
        }
        registerInitialTab()
      }
    })
    return () => { aborted = true }
  }, [])
}
