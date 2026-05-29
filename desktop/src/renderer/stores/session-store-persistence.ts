import type { PersistedTabState } from '../../shared/types'
import { usePreferencesStore } from '../preferences'
import { serializeTerminalBuffer } from '../components/TerminalInstance'
import type { useSessionStore as UseSessionStoreType } from './sessionStore'

type Store = typeof UseSessionStoreType

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
          const result: Record<string, any> = { engineInstances: hPane.instances }
          const { engineMessages: eMsgs } = useSessionStore.getState()
          const msgs: Record<string, any[]> = {}
          for (const inst of hPane.instances) {
            const k = `${t.id}:${inst.id}`
            const arr = eMsgs.get(k)
            if (arr && arr.length > 0) {
              msgs[inst.id] = arr.map((m) => ({ role: m.role, content: m.content, toolName: m.toolName, toolId: m.toolId, toolInput: m.toolInput, toolStatus: m.toolStatus, timestamp: m.timestamp, ...(m.dedupKey ? { dedupKey: m.dedupKey } : {}) }))
            }
          }
          if (Object.keys(msgs).length > 0) result.engineMessages = msgs
          const { engineAgentStates: eAgents } = useSessionStore.getState()
          const agentStates: Record<string, Array<{ name: string; id?: string; status: string; metadata?: Record<string, any> }>> = {}
          for (const inst of hPane.instances) {
            const k = `${t.id}:${inst.id}`
            const arr = eAgents.get(k)
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
          const { engineDraftInputs: eDrafts } = useSessionStore.getState()
          const drafts: Record<string, string> = {}
          for (const inst of hPane.instances) {
            const d = eDrafts.get(`${t.id}:${inst.id}`)
            if (d && d.length > 0) drafts[inst.id] = d
          }
          if (Object.keys(drafts).length > 0) result.engineDrafts = drafts
          const { enginePermissionDenied: eDenials } = useSessionStore.getState()
          const denials: Record<string, { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> }> = {}
          for (const inst of hPane.instances) {
            const d = eDenials.get(`${t.id}:${inst.id}`)
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
          const { engineConversationIds: eConvs } = useSessionStore.getState()
          const sessionIds: Record<string, string> = {}
          for (const inst of hPane.instances) {
            const chain = eConvs.get(`${t.id}:${inst.id}`)
            if (chain && chain.length > 0) {
              sessionIds[inst.id] = chain[chain.length - 1]
            }
          }
          if (Object.keys(sessionIds).length > 0) {
            result.engineSessionIds = sessionIds
          } else if (hPane.instances.length > 0) {
            // Diagnostic: engine tab has instances but zero session IDs
            // were resolved from the runtime map. This is the persisted
            // shape of the bug the plan addresses — on the next restart
            // `engineSessionIds` will be absent and every instance
            // starts a brand new engine conversation. Log the runtime
            // map's actual keys so we can see whether the source map
            // is keyed differently than the lookup expects (e.g.
            // `tabId` only vs. `${tabId}:${instanceId}`). This log is
            // permanent per the repo logging policy.
            const expectedKeys = hPane.instances.map((inst) => `${t.id}:${inst.id}`)
            const actualKeys = [...eConvs.keys()].filter((k) => k.startsWith(`${t.id}`) || k === t.id)
            console.log(`[persist] engineSessionIds empty for engine tab=${t.id.slice(0, 8)} instances=${hPane.instances.length} expectedKeys=${JSON.stringify(expectedKeys.map((k) => k.slice(0, 16)))} actualKeysUnderTab=${JSON.stringify(actualKeys.map((k) => k.slice(0, 16)))}`)
          }
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

  const { isExpanded, fileEditorOpenDirs, editorGeometry, planGeometry } = useSessionStore.getState()

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
    if (state.tabs !== prev.tabs || state.activeTabId !== prev.activeTabId || state.fileEditorStates !== prev.fileEditorStates || state.isExpanded !== prev.isExpanded || state.fileEditorOpenDirs !== prev.fileEditorOpenDirs || state.editorGeometry !== prev.editorGeometry || state.planGeometry !== prev.planGeometry || state.terminalPanes !== prev.terminalPanes || state.enginePanes !== prev.enginePanes || state.engineDraftInputs !== prev.engineDraftInputs || state.enginePermissionDenied !== prev.enginePermissionDenied) {
      // Flush immediately when permissionDenied changes on any tab — this
      // state must survive a crash or force-quit (e.g. the desktop is killed
      // while an engine run is in progress and the AskUserQuestion / ExitPlanMode
      // denial is never written to the conversation file). This covers both:
      //   - CLI tabs: `tab.permissionDenied` changing on `state.tabs`.
      //   - Engine tabs: `enginePermissionDenied` map identity change.
      const permissionDeniedChanged =
        (state.tabs !== prev.tabs && state.tabs.some((t, i) => {
          const p = prev.tabs[i]
          return p && t.id === p.id && t.permissionDenied !== p.permissionDenied
        })) ||
        state.enginePermissionDenied !== prev.enginePermissionDenied
      if (permissionDeniedChanged) {
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
