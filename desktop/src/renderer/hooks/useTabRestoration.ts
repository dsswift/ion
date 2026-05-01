import { useEffect } from 'react'
import type { Message, AgentStateUpdate } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { setSavedBuffer } from '../components/TerminalInstance'

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
      const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'

      // Try restoring saved tabs
      const saved = await window.ion.loadTabs().catch(() => null)
      if (saved && saved.tabs && saved.tabs.length > 0) {
        // Restore each saved tab
        const restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }> = []
        for (let i = 0; i < saved.tabs.length; i++) {
          const st = saved.tabs[i]
          if (st.conversationId && !st.isEngine) {
            // Conversation tab with a session -- resume it
            const tabId = await useSessionStore.getState().resumeSession(
              st.conversationId,
              st.title,
              st.workingDirectory,
            )
            restoredTabIds.push({ tabId, sessionId: st.conversationId, index: i })

            // Patch extra per-tab settings that resumeSession doesn't handle
            // Restore worktree info if present (verify path still exists)
            let restoredWorktree = st.worktree || null
            if (restoredWorktree) {
              try {
                const { entries } = await window.ion.fsReadDir(restoredWorktree.worktreePath)
                // Directory exists, keep the worktree info
              } catch {
                // Worktree was cleaned up externally
                restoredWorktree = null
              }
            }

            useSessionStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      customTitle: st.customTitle || null,
                      hasChosenDirectory: st.hasChosenDirectory,
                      additionalDirs: st.additionalDirs,
                      permissionMode: st.permissionMode,
                      bashResults: st.bashResults || [],
                      pillColor: st.pillColor || null,
                      pillIcon: st.pillIcon || null,
                      worktree: restoredWorktree,
                      historicalSessionIds: st.historicalSessionIds || [],
                      lastKnownSessionId: st.lastKnownSessionId || null,
                      groupId: st.groupId || null,
                      contextTokens: st.contextTokens || null,
                      queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
                      // Persisted permissionDenied is authoritative over resumeSession reconstruction
                      ...(st.permissionDenied ? { permissionDenied: st.permissionDenied } : {}),
                      ...(st.planFilePath ? { planFilePath: st.planFilePath } : {}),
                      // If worktree is valid, restore workingDirectory to worktree path
                      // If worktree was cleaned up, fall back to original repo path
                      ...(restoredWorktree
                        ? { workingDirectory: restoredWorktree.worktreePath }
                        : st.worktree ? { workingDirectory: st.worktree.repoPath } : {}),
                    }
                  : t
              ),
            }))
            window.ion.setPermissionMode(tabId, st.permissionMode, 'tab_restore')
          } else if (st.isEngine) {
            // Engine tab
            const tabId = useSessionStore.getState().createEngineTab(st.workingDirectory, st.engineProfileId || undefined)
            restoredTabIds.push({ tabId, sessionId: null, index: i })

            // Build all engine state before any setState call to avoid
            // intermediate renders where EngineView sees no instances
            // (its auto-create effect would fire, causing duplicate sessions
            // and cascading re-renders → React error #310).
            const restoredPanes = new Map(useSessionStore.getState().enginePanes)
            const restoredEngineMessages = new Map(useSessionStore.getState().engineMessages)
            const restoredEngineAgentStates = new Map(useSessionStore.getState().engineAgentStates)

            if (st.engineInstances && st.engineInstances.length > 0) {
              restoredPanes.set(tabId, {
                instances: st.engineInstances,
                activeInstanceId: st.engineInstances[0].id,
              })

              if (st.engineMessages) {
                for (const inst of st.engineInstances) {
                  const saved = st.engineMessages[inst.id]
                  if (saved && saved.length > 0) {
                    const key = `${tabId}:${inst.id}`
                    restoredEngineMessages.set(key, saved.map((m) => ({
                      id: crypto.randomUUID(),
                      role: m.role as Message['role'],
                      content: m.content,
                      toolName: m.toolName,
                      toolId: m.toolId,
                      toolStatus: m.toolStatus as Message['toolStatus'],
                      timestamp: m.timestamp,
                    })))
                  }
                }
              }

              if (st.engineAgentStates) {
                for (const inst of st.engineInstances) {
                  const saved = st.engineAgentStates[inst.id]
                  if (saved && saved.length > 0) {
                    const key = `${tabId}:${inst.id}`
                    restoredEngineAgentStates.set(key, saved.map((a) => ({
                      name: a.name,
                      status: (a.status === 'running' ? 'done' : a.status) as AgentStateUpdate['status'],
                      metadata: a.metadata,
                    })))
                  }
                }
              }
            }

            // Single atomic setState: tab metadata + panes + messages + agent states
            useSessionStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      customTitle: st.customTitle || null,
                      pillColor: st.pillColor || null,
                      groupId: st.groupId || null,
                      conversationId: st.conversationId || null,
                    }
                  : t
              ),
              enginePanes: restoredPanes,
              engineMessages: restoredEngineMessages,
              engineAgentStates: restoredEngineAgentStates,
            }))

            // Start engine processes (state is fully set up)
            if (st.engineInstances && st.engineInstances.length > 0) {
              const { engineProfiles } = usePreferencesStore.getState()
              const profile = st.engineProfileId ? engineProfiles.find((p) => p.id === st.engineProfileId) : null
              if (profile) {
                for (const inst of st.engineInstances) {
                  const key = `${tabId}:${inst.id}`
                  window.ion.engineStart(key, {
                    profileId: profile.id,
                    extensions: profile.extensions,
                    workingDirectory: st.workingDirectory,
                    ...(st.conversationId ? { sessionId: st.conversationId } : {}),
                  }).catch((err: any) => {
                    console.error(`[restore] engine start failed for ${key}: ${err.message}`)
                  })
                }
              }
            }
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
                    }
                  : t
              ),
            }))

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

            useSessionStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      customTitle: st.customTitle || null,
                      hasChosenDirectory: st.hasChosenDirectory,
                      additionalDirs: st.additionalDirs,
                      permissionMode: st.permissionMode,
                      pillColor: st.pillColor || null,
                      pillIcon: st.pillIcon || null,
                      forkedFromSessionId: st.forkedFromSessionId || null,
                      worktree: st.worktree || null,
                      historicalSessionIds: st.historicalSessionIds || [],
                      lastKnownSessionId: st.lastKnownSessionId || null,
                      groupId: st.groupId || null,
                      contextTokens: st.contextTokens || null,
                      queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
                    }
                  : t
              ),
            }))
            window.ion.setPermissionMode(tabId, st.permissionMode, 'tab_restore')
          }
        }

        // Load historical session messages for tabs that have them
        for (const { tabId, index } of restoredTabIds) {
          const st = saved.tabs[index]
          const historicalIds = st.historicalSessionIds || []
          if (historicalIds.length > 0) {
            const allHistoricalMessages: Message[] = []
            for (const hid of historicalIds) {
              const history = await window.ion.loadSession(hid, st.workingDirectory).catch(() => [])
              const msgs = history.map((m) => ({
                id: crypto.randomUUID(),
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
              allHistoricalMessages.push(...msgs)
            }

            if (allHistoricalMessages.length > 0) {
              // If tab has no active session and combined messages end with
              // ExitPlanMode/AskUserQuestion, restore the plan card so the
              // user can re-implement without hunting through history.
              const combinedMessages = [...allHistoricalMessages, ...(useSessionStore.getState().tabs.find((t) => t.id === tabId)?.messages || [])]
              const tab = useSessionStore.getState().tabs.find((t) => t.id === tabId)
              let restoredDenied = tab?.permissionDenied ?? null
              if (!restoredDenied && !tab?.conversationId) {
                const lastTool = [...combinedMessages].reverse().find((m) => m.toolName)
                if (lastTool?.toolName === 'ExitPlanMode' || lastTool?.toolName === 'AskUserQuestion') {
                  restoredDenied = { tools: [{ toolName: lastTool.toolName, toolUseId: 'restored' }] }
                }
              }

              useSessionStore.setState((s) => ({
                tabs: s.tabs.map((t) =>
                  t.id === tabId
                    ? {
                        ...t,
                        messages: [...allHistoricalMessages, ...t.messages],
                        ...(restoredDenied ? { permissionDenied: restoredDenied } : {}),
                      }
                    : t
                ),
              }))
            }
          }
        }

        // Fallback: recover messages from lastKnownSessionId when both
        // conversationId and historicalSessionIds are empty
        for (const { tabId, index } of restoredTabIds) {
          const st = saved.tabs[index]
          const historicalIds = st.historicalSessionIds || []
          if (!st.conversationId && historicalIds.length === 0 && st.lastKnownSessionId) {
            const history = await window.ion.loadSession(st.lastKnownSessionId, st.workingDirectory).catch(() => [])
            if (history.length > 0) {
              const msgs = history.map((m) => ({
                id: crypto.randomUUID(),
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
              useSessionStore.setState((s) => ({
                tabs: s.tabs.map((t) =>
                  t.id === tabId
                    ? { ...t, messages: [...msgs, ...t.messages] }
                    : t
                ),
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
            // Also mark terminal as open so the pane is visible
            useSessionStore.setState((s) => ({
              terminalOpenTabIds: new Set([...s.terminalOpenTabIds, tabId]),
            }))
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

        // Restore expanded/collapsed state, or fall back to setting
        const restoredExpanded = typeof saved.isExpanded === 'boolean'
          ? saved.isExpanded
          : usePreferencesStore.getState().expandOnTabSwitch
        useSessionStore.setState({ isExpanded: restoredExpanded, tabsReady: true })
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
        const registerInitialTab = async (retries = 5): Promise<void> => {
          for (let i = 0; i < retries; i++) {
            try {
              const { tabId } = await window.ion.createTab()
              useSessionStore.setState((s) => ({
                tabs: s.tabs.map((t, idx) => (idx === 0 ? { ...t, id: tabId } : t)),
                activeTabId: tabId,
                tabsReady: true,
              }))
              return
            } catch {
              if (i < retries - 1) await new Promise((r) => setTimeout(r, 500))
            }
          }
          // All retries failed — still set tabsReady so UI isn't stuck forever
          useSessionStore.setState({ tabsReady: true })
        }
        registerInitialTab()
      }
    })
    return () => { aborted = true }
  }, [])
}
