import type { PersistedTabState } from '../../shared/types'
import { usePreferencesStore } from '../preferences'
import { serializeTerminalBuffer } from '../components/TerminalInstance'
import type { useSessionStore as UseSessionStoreType } from './sessionStore'

type Store = typeof UseSessionStoreType

/**
 * Extension error messages are operational diagnostics, not conversation
 * content. They should never be persisted — they clutter restored conversations
 * with stale errors from previous sessions. This predicate identifies them so
 * they can be stripped on save and restore.
 */
export function isExtensionErrorMessage(m: { role: string; content: string }): boolean {
  if (m.role !== 'system') return false
  const c = m.content
  // extension subprocess died — hooks disabled until restart
  if (c.startsWith('Error: extension') && c.includes('subprocess died')) return true
  // Extension X crashed N times in 60s and will not be restarted
  if (c.includes('crashed') && c.includes('will not be restarted')) return true
  // extension hook session_start failed: jsonrpc error ...
  if (c.startsWith('Error: extension hook') && c.includes('failed:')) return true
  // extension load failed: ...
  if (c.startsWith('Error: extension load failed')) return true
  // extension X respawn failed: ...
  if (c.startsWith('Error: extension') && c.includes('respawn failed')) return true
  return false
}

function persistTabs(useSessionStore: Store): void {
  const { tabs, activeTabId } = useSessionStore.getState()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const dirsWithEditorState = new Set<string>()
  for (const [dir, dirState] of useSessionStore.getState().fileEditorStates) {
    if (dirState.files.length > 0) dirsWithEditorState.add(dir)
  }
  void dirsWithEditorState

  const { terminalPanes, enginePanes } = useSessionStore.getState()

  const persistedTabs = tabs
    .map((t) => {
      const pane = terminalPanes.get(t.id)
      return {
        conversationId: t.conversationId,
        title: t.customTitle || t.title,
        customTitle: t.customTitle,
        workingDirectory: t.workingDirectory,
        hasChosenDirectory: t.hasChosenDirectory,
        additionalDirs: t.additionalDirs,
        permissionMode: t.permissionMode,
        messageCount: t.messages?.length ?? t.messageCount ?? 0,
        ...(t.historicalSessionIds.length > 0 ? { historicalSessionIds: t.historicalSessionIds } : {}),
        ...(t.lastKnownSessionId ? { lastKnownSessionId: t.lastKnownSessionId } : {}),
        ...(t.bashResults.length > 0 ? { bashResults: t.bashResults } : {}),
        ...(t.pillColor ? { pillColor: t.pillColor } : {}),
        ...(t.pillIcon ? { pillIcon: t.pillIcon } : {}),
        ...(t.modelOverride ? { modelOverride: t.modelOverride } : {}),
        ...(t.forkedFromSessionId ? { forkedFromSessionId: t.forkedFromSessionId } : {}),
        ...(t.worktree ? { worktree: t.worktree } : {}),
        ...(t.groupId ? { groupId: t.groupId } : {}),
        ...(t.groupPinned ? { groupPinned: true } : {}),
        ...(t.queuedPrompts.length > 0 ? { queuedPrompts: t.queuedPrompts } : {}),
        ...(t.draftInput ? { draftInput: t.draftInput } : {}),
        ...(t.contextTokens ? { contextTokens: t.contextTokens } : {}),
        ...(t.permissionDenied ? { permissionDenied: t.permissionDenied } : {}),
        ...(t.planFilePath ? { planFilePath: t.planFilePath } : {}),
        ...(t.lastMessagePreview ? { lastMessagePreview: t.lastMessagePreview } : {}),
        ...(t.lastEventAt ? { lastEventAt: t.lastEventAt } : {}),
        ...(t.isTerminalOnly ? { isTerminalOnly: true } : {}),
        ...(t.isEngine ? { isEngine: true, engineProfileId: t.engineProfileId } : {}),
        ...(t.isEngine ? (() => {
          const hPane = enginePanes.get(t.id)
          if (!hPane || hPane.instances.length === 0) return {}
          // Strip messages and agentStates from the persisted instances —
          // they are already serialized into the separate engineMessages
          // and engineAgentStates maps below. Writing them twice doubled
          // the tabs file size (~13.5 MB of redundant data in a 28.8 MB
          // file), causing startup parse overhead and persistence churn.
          const result: Record<string, any> = { engineInstances: hPane.instances.map(({ messages, agentStates, ...rest }) => rest) }
          const msgs: Record<string, any[]> = {}
          for (const inst of hPane.instances) {
            const arr = inst.messages?.filter((m) => !isExtensionErrorMessage(m))
            if (arr && arr.length > 0) {
              msgs[inst.id] = arr.map((m) => ({ role: m.role, content: m.content, toolName: m.toolName, toolId: m.toolId, toolInput: m.toolInput, toolStatus: m.toolStatus, timestamp: m.timestamp, ...(m.dedupKey ? { dedupKey: m.dedupKey } : {}), ...(m.planFilePath ? { planFilePath: m.planFilePath } : {}), ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}) }))
            }
          }
          if (Object.keys(msgs).length > 0) result.engineMessages = msgs
          const agentStates: Record<string, Array<{ name: string; id?: string; status: string; metadata?: Record<string, any> }>> = {}
          for (const inst of hPane.instances) {
            const arr = inst.agentStates
            if (arr && arr.length > 0) {
              agentStates[inst.id] = arr.map((a) => ({
                name: a.name,
                ...(a.id ? { id: a.id } : {}),
                status: a.status === 'running' ? 'done' : a.status,
                ...(a.metadata ? { metadata: a.metadata } : {}),
              }))
            }
          }
          if (Object.keys(agentStates).length > 0) result.engineAgentStates = agentStates
          const drafts: Record<string, string> = {}
          for (const inst of hPane.instances) {
            const d = inst.draftInput
            if (d && d.length > 0) drafts[inst.id] = d
          }
          if (Object.keys(drafts).length > 0) result.engineDrafts = drafts
          const denials: Record<string, { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> }> = {}
          for (const inst of hPane.instances) {
            const d = inst.permissionDenied
            if (d && d.tools && d.tools.length > 0) {
              denials[inst.id] = { tools: d.tools }
            }
          }
          if (Object.keys(denials).length > 0) result.engineDenials = denials
          // Persist the most recent conversation ID for each instance so
          // we can resume the engine session with continuity on relaunch
          // and so the denial-backfill hook can locate the right
          // conversation file. The runtime map (engineConversationIds)
          // is keyed by the compound `${tabId}:${instanceId}` and may
          // hold a chain of historical IDs — we serialize only the most
          // recent (last) ID per instance.
          const sessionIds: Record<string, string> = {}
          for (const inst of hPane.instances) {
            const chain = inst.conversationIds
            if (chain && chain.length > 0) {
              sessionIds[inst.id] = chain[chain.length - 1]
            }
          }
          if (Object.keys(sessionIds).length > 0) {
            result.engineSessionIds = sessionIds
          } else if (hPane.instances.length > 0) {
            // Diagnostic: engine tab has instances but zero session IDs were
            // resolved from the instance fields. This means conversationIds
            // was not populated — on next restart these instances will start
            // fresh engine conversations. Log instance IDs for investigation.
            console.log(`[persist] engineSessionIds empty for engine tab=${t.id.slice(0, 8)} instances=${hPane.instances.length} instanceIds=${JSON.stringify(hPane.instances.map((i) => i.id.slice(0, 8)))}`)
          }
          const modelOverrides: Record<string, string> = {}
          for (const inst of hPane.instances) {
            const m = inst.modelOverride
            if (m && m.length > 0) modelOverrides[inst.id] = m
          }
          if (Object.keys(modelOverrides).length > 0) result.engineModelOverrides = modelOverrides
          const permModes: Record<string, 'auto' | 'plan'> = {}
          for (const inst of hPane.instances) {
            const m = inst.permissionMode
            if (m && m !== 'auto') permModes[inst.id] = m
          }
          if (Object.keys(permModes).length > 0) result.enginePermissionModes = permModes
          const forkedChains: Record<string, string[]> = {}
          for (const inst of hPane.instances) {
            if (inst.forkedFromConversationIds && inst.forkedFromConversationIds.length > 0) {
              forkedChains[inst.id] = inst.forkedFromConversationIds
            }
          }
          if (Object.keys(forkedChains).length > 0) result.engineForkedFromConversationIds = forkedChains
          return result
        })() : {}),
        ...(pane && pane.instances.length > 0 ? { terminalInstances: pane.instances } : {}),
        ...(pane && pane.instances.length > 0 ? (() => {
          const buffers: Record<string, string> = {}
          for (const inst of pane.instances) {
            const buf = serializeTerminalBuffer(`${t.id}:${inst.id}`)
            if (buf) buffers[inst.id] = buf
          }
          return Object.keys(buffers).length > 0 ? { terminalBuffers: buffers } : {}
        })() : {}),
      }
    })

  const { fileEditorStates } = useSessionStore.getState()
  const editorStates: Record<string, any> = {}
  for (const [dir, dirState] of fileEditorStates) {
    if (dirState.files.length > 0) {
      const activeIdx = dirState.activeFileId
        ? dirState.files.findIndex((f) => f.id === dirState.activeFileId)
        : -1
      editorStates[dir] = {
        activeFileIndex: activeIdx >= 0 ? activeIdx : 0,
        files: dirState.files.map((f) => ({
          filePath: f.filePath,
          fileName: f.fileName,
          content: f.content,
          savedContent: f.savedContent,
          isDirty: f.isDirty,
          isReadOnly: f.isReadOnly,
          isPreview: f.isPreview,
        })),
      }
    }
  }

  const { isExpanded, fileEditorOpenDirs, editorGeometry, planGeometry, agentDetailGeometry } = useSessionStore.getState()

  let activeTabIndex: number | null = null
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i].id === activeTabId) { activeTabIndex = i; break }
  }

  const data: PersistedTabState = {
    activeSessionId: activeTab?.conversationId || null,
    activeTabIndex,
    tabs: persistedTabs,
    editorStates: Object.keys(editorStates).length > 0 ? editorStates : undefined,
    isExpanded,
    editorOpenDirs: fileEditorOpenDirs.size > 0 ? [...fileEditorOpenDirs] : undefined,
    editorGeometry,
    planGeometry,
    agentDetailGeometry,
  }
  window.ion.saveTabs(data)

  void persistSessionChains(useSessionStore)
}

async function persistSessionChains(useSessionStore: Store): Promise<void> {
  try {
    const { tabs } = useSessionStore.getState()
    const existing = await window.ion.loadSessionChains()
    const chains: Record<string, string[]> = { ...existing.chains }
    const reverse: Record<string, string> = { ...existing.reverse }

    for (const tab of tabs) {
      if (tab.historicalSessionIds.length > 0 && tab.conversationId) {
        const rootId = tab.historicalSessionIds[0]
        const continuations = [...tab.historicalSessionIds.slice(1), tab.conversationId]
        chains[rootId] = continuations
        for (const cId of continuations) {
          reverse[cId] = rootId
        }
        delete reverse[rootId]
      }
    }

    await window.ion.saveSessionChains({ chains, reverse })
  } catch {
    // Non-critical
  }
}

const WATCHDOG_INTERVAL_MS = 5_000

function scanForStuckTabs(useSessionStore: Store): void {
  const { tabRecoveryEnabled, tabRecoveryTimeoutSec } = usePreferencesStore.getState()
  if (!tabRecoveryEnabled) return
  const thresholdMs = tabRecoveryTimeoutSec * 1000
  const now = Date.now()
  const { tabs, forceRecoverTab } = useSessionStore.getState()
  for (const t of tabs) {
    if (t.status !== 'running' && t.status !== 'connecting') continue
    if (!t.activeRequestId) continue
    if (t.lastEventAt === null) continue
    if (now - t.lastEventAt <= thresholdMs) continue
    forceRecoverTab(t.id, `Tab idle for ${Math.round((now - t.lastEventAt) / 1000)}s with no engine activity. The engine may have hung; sending stop and resetting the tab. You can resume the conversation.`)
  }
}

export function setupPersistence(useSessionStore: Store): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  useSessionStore.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs || state.activeTabId !== prev.activeTabId || state.fileEditorStates !== prev.fileEditorStates || state.isExpanded !== prev.isExpanded || state.fileEditorOpenDirs !== prev.fileEditorOpenDirs || state.editorGeometry !== prev.editorGeometry || state.planGeometry !== prev.planGeometry || state.agentDetailGeometry !== prev.agentDetailGeometry || state.terminalPanes !== prev.terminalPanes || state.enginePanes !== prev.enginePanes) {
      // Flush immediately when permissionDenied changes on any tab — this
      // state must survive a crash or force-quit (e.g. the desktop is killed
      // while an engine run is in progress and the AskUserQuestion / ExitPlanMode
      // denial is never written to the conversation file). This covers:
      //   - CLI tabs: `tab.permissionDenied` changing on `state.tabs`.
      //   - Engine tabs: per-instance `permissionDenied` changing on enginePanes.
      //
      // IMPORTANT: The engine-tab check must compare per-instance permissionDenied
      // precisely — NOT use `state.enginePanes !== prev.enginePanes`. The Map
      // identity changes on every RAF text-delta flush (~60fps during streaming)
      // because withInstanceMessages creates a new Map. Using the coarse check
      // bypassed the 100ms debounce and caused persistTabs() (4 synchronous
      // filesystem ops + full JSON serialization) to fire at 60fps.
      const permissionDeniedChanged =
        (state.tabs !== prev.tabs && state.tabs.some((t, i) => {
          const p = prev.tabs[i]
          return p && t.id === p.id && t.permissionDenied !== p.permissionDenied
        })) ||
        (state.enginePanes !== prev.enginePanes && (() => {
          for (const [tabId, pane] of state.enginePanes) {
            const prevPane = prev.enginePanes.get(tabId)
            if (!prevPane) continue
            for (const inst of pane.instances) {
              const prevInst = prevPane.instances.find((p) => p.id === inst.id)
              if (prevInst && inst.permissionDenied !== prevInst.permissionDenied) return true
            }
          }
          return false
        })())

      // Flush immediately when a CLI tab captures its first conversationId.
      // The engine event slice already does this for engine tabs via
      // __ionForceFlushTabs (engine-event-slice.ts:126–142). For CLI tabs,
      // session_init sets conversationId inside the Zustand reducer
      // (event-slice.ts), and the normal 100ms debounce creates a window
      // where a hard kill (SIGUSR1 drain → app.exit, laptop lid close)
      // drops the session ID — making the tab irrecoverable on restart
      // (conversationId: null → sessionless blank tab path).
      const conversationIdCaptured =
        state.tabs !== prev.tabs && state.tabs.some((t, i) => {
          const p = prev.tabs[i]
          return p && t.id === p.id && !p.conversationId && !!t.conversationId
        })

      if (permissionDeniedChanged || conversationIdCaptured) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
        persistTabs(useSessionStore)
        return
      }
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => persistTabs(useSessionStore), 100)
    }
  })

  ;(window as any).__ionForceFlushTabs = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    persistTabs(useSessionStore)
  }

  setInterval(() => scanForStuckTabs(useSessionStore), WATCHDOG_INTERVAL_MS)
  window.addEventListener('focus', () => scanForStuckTabs(useSessionStore))

  useSessionStore.subscribe((state, prev) => {
    if (prev.isExpanded && !state.isExpanded) {
      const { keepTerminalOnCollapse, keepExplorerOnCollapse, keepGitPanelOnCollapse } = usePreferencesStore.getState()
      const { activeTabId, terminalOpenTabIds, fileExplorerOpenDirs, tabs: currentTabs } = state
      const updates: Record<string, any> = {}
      if (!keepTerminalOnCollapse && terminalOpenTabIds.has(activeTabId)) {
        const next = new Set(terminalOpenTabIds)
        next.delete(activeTabId)
        updates.terminalOpenTabIds = next
      }
      const activeDir = currentTabs.find((t) => t.id === activeTabId)?.workingDirectory
      if (!keepExplorerOnCollapse && activeDir && fileExplorerOpenDirs.has(activeDir)) {
        const next = new Set(fileExplorerOpenDirs)
        next.delete(activeDir)
        updates.fileExplorerOpenDirs = next
      }
      if (!keepGitPanelOnCollapse && state.gitPanelOpen) {
        updates.gitPanelOpen = false
      }
      if (Object.keys(updates).length > 0) {
        useSessionStore.setState(updates)
      }
    }
  })
}
