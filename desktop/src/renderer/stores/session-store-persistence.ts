import type { PersistedTabState } from '../../shared/types'
import { usePreferencesStore } from '../preferences'
import { serializeTerminalBuffer } from '../components/TerminalInstance'
import { serializeConversationPane } from './serialize-conversation-pane'
import { UNIFIED_SCHEMA_VERSION } from '../../main/tab-migration-unify'
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

  const { terminalPanes, conversationPanes } = useSessionStore.getState()

  const persistedTabs = tabs
    .map((t) => {
      const pane = terminalPanes.get(t.id)
      // Conversation state is persisted as the unified conversationPane
      // (schemaVersion 2). A plain conversation serializes its single `main`
      // instance (count only — content reloads from the conversation file); an
      // extension-hosted conversation serializes content per instance. The old
      // split shape (flat fields + engine* maps) is no longer written.
      const convoPane = serializeConversationPane(conversationPanes.get(t.id), {
        hasEngineExtension: !!t.hasEngineExtension,
        tabIdForLog: t.id,
      })
      return {
        conversationId: t.conversationId,
        title: t.customTitle || t.title,
        customTitle: t.customTitle,
        workingDirectory: t.workingDirectory,
        hasChosenDirectory: t.hasChosenDirectory,
        additionalDirs: t.additionalDirs,
        permissionMode: t.permissionMode,
        ...(convoPane ? { conversationPane: convoPane } : {}),
        ...(t.historicalSessionIds.length > 0 ? { historicalSessionIds: t.historicalSessionIds } : {}),
        ...(t.lastKnownSessionId ? { lastKnownSessionId: t.lastKnownSessionId } : {}),
        ...(t.bashResults.length > 0 ? { bashResults: t.bashResults } : {}),
        ...(t.pillColor ? { pillColor: t.pillColor } : {}),
        ...(t.pillIcon ? { pillIcon: t.pillIcon } : {}),
        ...(t.forkedFromSessionId ? { forkedFromSessionId: t.forkedFromSessionId } : {}),
        ...(t.worktree ? { worktree: t.worktree } : {}),
        ...(t.groupId ? { groupId: t.groupId } : {}),
        ...(t.groupPinned ? { groupPinned: true } : {}),
        ...(t.queuedPrompts.length > 0 ? { queuedPrompts: t.queuedPrompts } : {}),
        ...(t.contextTokens ? { contextTokens: t.contextTokens } : {}),
        ...(t.lastMessagePreview ? { lastMessagePreview: t.lastMessagePreview } : {}),
        ...(t.lastEventAt ? { lastEventAt: t.lastEventAt } : {}),
        ...(t.isTerminalOnly ? { isTerminalOnly: true } : {}),
        ...(t.hasEngineExtension ? { hasEngineExtension: true, engineProfileId: t.engineProfileId } : {}),
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
    schemaVersion: UNIFIED_SCHEMA_VERSION,
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
    if (state.tabs !== prev.tabs || state.activeTabId !== prev.activeTabId || state.fileEditorStates !== prev.fileEditorStates || state.isExpanded !== prev.isExpanded || state.fileEditorOpenDirs !== prev.fileEditorOpenDirs || state.editorGeometry !== prev.editorGeometry || state.planGeometry !== prev.planGeometry || state.agentDetailGeometry !== prev.agentDetailGeometry || state.terminalPanes !== prev.terminalPanes || state.conversationPanes !== prev.conversationPanes) {
      // Flush immediately when permissionDenied changes on any tab — this
      // state must survive a crash or force-quit (e.g. the desktop is killed
      // while an engine run is in progress and the AskUserQuestion / ExitPlanMode
      // denial is never written to the conversation file). Per-conversation
      // permissionDenied now lives on the instance for EVERY tab (normal tabs
      // use their `main` instance), so the single conversationPanes scan below covers
      // both CLI and engine tabs.
      //
      // IMPORTANT: compare per-instance permissionDenied precisely — NOT
      // `state.conversationPanes !== prev.conversationPanes`. The Map identity changes on
      // every RAF text-delta flush (~60fps during streaming) because the
      // streaming commit creates a new Map. Using the coarse check bypassed the
      // 100ms debounce and caused persistTabs() (4 synchronous filesystem ops +
      // full JSON serialization) to fire at 60fps.
      const permissionDeniedChanged =
        state.conversationPanes !== prev.conversationPanes && (() => {
          for (const [tabId, pane] of state.conversationPanes) {
            const prevPane = prev.conversationPanes.get(tabId)
            if (!prevPane) continue
            for (const inst of pane.instances) {
              const prevInst = prevPane.instances.find((p) => p.id === inst.id)
              if (prevInst && inst.permissionDenied !== prevInst.permissionDenied) return true
            }
          }
          return false
        })()

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
