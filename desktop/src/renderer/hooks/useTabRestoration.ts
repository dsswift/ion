import { useEffect } from 'react'
import type { TabState } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { setSavedBuffer } from '../components/TerminalInstance'
import { restoreConversationTab } from './useTabRestoration-engine'
import { makeLocalTab } from '../stores/session-store-helpers'
import { makeMainPane, commitInstance } from '../stores/conversation-instance'
import { normalizeLegacyTabFields, readMainInstance, seedContextStatusFields, reassertRestoredPlanMode, resolveBootActiveTabId, hydrateBootActiveTab, hydrateBootWorkspace } from './useTabRestoration-helpers'
import { startRestoredSessions } from './useTabRestoration-sessions'
import { loadRestoredHistory } from './useTabRestoration-history'
import { resolveRegisteredWorktree } from '../stores/worktree-registration'
import { persistedTabHasExtensions } from '../../shared/tab-predicates'
import { rDebug, rWarn, rError } from '../rendererLogger'

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
      const saved = await window.ion.loadTabs().catch((err) => {
        // A failed tab load silently loses the user's restored session — log it.
        rWarn('restore', 'loadTabs failed; starting with no restored tabs', { error: String(err) })
        return null
      })
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
        // Per-tab result of the "is this worktree still on disk" probe, keyed by
        // saved-tab index. Shared with the eager session start below so the tab
        // state and its session resolve one directory, not two.
        const worktreeAliveByIndex = new Map<number, boolean>()
        for (let i = 0; i < saved.tabs.length; i++) {
          useSessionStore.setState({ initProgress: `Restoring tab ${i + 1} of ${saved.tabs.length}…` })
          let st = saved.tabs[i]
          // Heal legacy/additional tabs that persisted a managed worktree path
          // without worktree metadata. Do this before routing any restore path:
          // every path must render and start with one authoritative identity.
          const registeredWorktree = st.isTerminalOnly
            ? (st.worktree ?? null)
            : await resolveRegisteredWorktree(st.workingDirectory, st.worktree)
          if (!st.worktree && registeredWorktree) {
            st = { ...st, worktree: registeredWorktree }
            saved.tabs[i] = st
          }
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
            // Record the probe result so the eager session start below resolves
            // the SAME directory the tab state gets. Reading the raw persisted
            // `workingDirectory` there is what put worktree conversations back
            // in the base repo on every restart.
            worktreeAliveByIndex.set(i, restoredWorktree !== null)

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
                  // Absent means 'off' — the serializer omits the default.
                  thinkingEffort: main?.thinkingEffort ?? 'off',
                  // Persisted permissionDenied is authoritative over resumeSession reconstruction
                  ...(main?.permissionDenied ? { permissionDenied: main.permissionDenied } : {}),
                  ...(main?.planFilePath ? { planFilePath: main.planFilePath } : {}),
                  ...seedContextStatusFields(inst, main),
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
                          inputLocked: st.inputLocked ?? false,
                          tabRole: st.tabRole ?? null,
                          worktree: restoredWorktree,
                          historicalSessionIds: st.historicalSessionIds || [],
                          lastKnownSessionId: st.lastKnownSessionId || null,
                          groupId: st.groupId || null,
                          groupPinned: st.groupPinned ?? false,
                          contextTokens: main?.contextTokens ?? st.contextTokens ?? null,
                          contextWindow: main?.contextWindow ?? st.contextWindow ?? null,
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

              // Read the persisted `main` instance up front: the tab literal
              // below seeds its context scalars from it, and the skeleton
              // pane built afterwards reuses the same read.
              const main = readMainInstance(st)

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
                inputLocked: st.inputLocked ?? false,
                tabRole: st.tabRole ?? null,
                forkedFromSessionId: st.forkedFromSessionId || null,
                worktree: restoredWorktree,
                groupId: st.groupId || null,
                groupPinned: st.groupPinned ?? false,
                contextTokens: main?.contextTokens ?? st.contextTokens ?? null,
                contextWindow: main?.contextWindow ?? st.contextWindow ?? null,
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
              // permissionMode: prefer instance-persisted; fall back to legacy tab-level field.
              const skeletonMode: 'auto' | 'plan' = main?.permissionMode ?? (st as any).permissionMode ?? 'auto'
              const pane = makeMainPane({
                messages: [],
                // Skeleton restore: history loads lazily (loadSkeletonMessages).
                // The explicit marker keeps hydration correct even if live
                // events land on this pane before the user opens the tab.
                historyHydrated: false,
                messageCount: main?.messageCount ?? 0,
                modelOverride: main?.modelOverride || null,
                draftInput: main?.draftInput ?? '',
                permissionDenied: main?.permissionDenied ?? null,
                planFilePath: main?.planFilePath ?? null,
                permissionMode: skeletonMode,
                // Absent means 'off' — the serializer omits the default.
                thinkingEffort: main?.thinkingEffort ?? 'off',
                // Context occupancy so the indicator is correct on first
                // paint, before any engine status arrives.
                ...seedContextStatusFields({}, main),
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
              // Absent means 'off' — the serializer omits the default.
              thinkingEffort: sessionlessMain?.thinkingEffort ?? 'off',
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
                        inputLocked: st.inputLocked ?? false,
                        tabRole: st.tabRole ?? null,
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
        // that have a conversationId. Staggered ordering, the worktree-aware
        // directory resolution, and the per-tab logging all live in the sibling
        // module — see useTabRestoration-sessions.ts.
        await startRestoredSessions(
          restoredTabIds,
          saved.tabs,
          saved.activeTabIndex ?? -1,
          worktreeAliveByIndex,
          persistedTabHasExtensions,
        )

        await loadRestoredHistory(saved, restoredTabIds)

        // Set active tab by index (handles both session and sessionless tabs),
        // then hydrate it. The boot-active tab is set via raw setState —
        // selectTab never runs for it, so selectTab's lazy-hydration trigger
        // never fires; hydrateBootActiveTab applies the same gate explicitly.
        const bootActiveTabId = resolveBootActiveTabId(saved, restoredTabIds)
        if (bootActiveTabId) {
          useSessionStore.setState({ activeTabId: bootActiveTabId })
          const store = useSessionStore.getState()
          hydrateBootActiveTab(store, bootActiveTabId)
          const bootActiveTab = store.tabs.find((t) => t.id === bootActiveTabId)
          // `tabsReady` stays false until this finishes. A restored bench tab has
          // no worktree metadata, so exposing GitPanel before main resolves its
          // owner makes the bench path look like a repo on the first frame.
          await hydrateBootWorkspace(
            bootActiveTab,
            store.refreshWorkspaceViews,
            window.ion.benchResolvePath,
          )
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
        registerInitialTab().catch((err) => rError('tab-restore', 'registerInitialTab failed', { error: String(err) }))
      }
    }).catch((err) => rError('tab-restore', 'bootstrap tab restoration failed', { error: String(err) }))
    return () => { aborted = true }
  }, [])
}
