import type { PersistedTabState } from '../../shared/types'
import { usePreferencesStore } from '../preferences'
import { serializeTerminalBuffer } from '../components/TerminalInstance'
import { serializeConversationPane, collectExternalInstanceMessages, isExtensionErrorMessage, resolvePersistedLastKnownSessionId } from './serialize-conversation-pane'
import { tabContentDirty, markTabContentWritten } from './tab-content-tracking'
import { activeInstance } from './conversation-instance'
import { SPLIT_SCHEMA_VERSION } from '../../main/tab-migration-split'
import type { useSessionStore as UseSessionStoreType } from './sessionStore'

type Store = typeof UseSessionStoreType

// isExtensionErrorMessage is defined in serialize-conversation-pane.ts and
// re-exported here for backward compatibility with call sites that import it
// from session-store-persistence.
export { isExtensionErrorMessage, resolvePersistedLastKnownSessionId }

/**
 * Write the external content file for every tab whose externalizable
 * scrollback changed since the last write, on the SAME tick as the thin-file
 * save (change-tracked per tab — see tab-content-tracking.ts). A tab whose
 * content collector returns null but that previously wrote content keeps its
 * file — deletion happens only on tab close (closeTab → deleteTabContent)
 * plus the main-process orphan sweep, never on a transient empty
 * serialization.
 */
function persistExternalContent(useSessionStore: Store): void {
  const { tabs, conversationPanes } = useSessionStore.getState()
  for (const t of tabs) {
    const pane = conversationPanes.get(t.id)
    const inst = pane?.instances[0]
    if (!inst) continue
    if (!tabContentDirty(t.id, inst.messages)) continue
    const content = collectExternalInstanceMessages(pane)
    if (!content) continue
    markTabContentWritten(t.id, inst.messages)
    void window.ion.saveTabContent(t.id, content.instanceId, content.messages)
  }
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
      // (schemaVersion 2). Whether to persist message content (vs. count-only)
      // is determined by a data fact — does the instance contain renderer-only
      // rows (harness, system) that cannot be reloaded from the engine
      // conversation file? No tab-type branch; see serialize-conversation-pane.ts.
      const convoPane = serializeConversationPane(conversationPanes.get(t.id), {
        tabIdForLog: t.id,
      })
      // Extension-hosted tab metadata (profile id) is written so restoration can
      // restart the engine session with the correct profile.
      const isEngine = t.engineProfileId != null && t.engineProfileId !== ''
      // Preserve the last real conversation id in lastKnownSessionId so a
      // transient empty / engine-minted conversationId never erases the tab's
      // ability to resume its original conversation on the next restore. Reads
      // from the active instance's conversation chain as a last source.
      const inst = activeInstance(conversationPanes, t.id)
      const persistedLastKnown = resolvePersistedLastKnownSessionId({
        conversationId: t.conversationId,
        lastKnownSessionId: t.lastKnownSessionId,
        historicalSessionIds: t.historicalSessionIds,
        instanceConversationIds: inst?.conversationIds,
      })
      return {
        // Persist the durable tab identity. The session key == tabId, and the
        // engine binding store is keyed on it; writing it here is what lets
        // restore reuse the same key across restarts instead of minting a fresh
        // one (which fragmented conversations into disjoint files). See
        // PersistedTab.id in types-persistence.ts.
        id: t.id,
        conversationId: t.conversationId,
        title: t.customTitle || t.title,
        customTitle: t.customTitle,
        workingDirectory: t.workingDirectory,
        hasChosenDirectory: t.hasChosenDirectory,
        additionalDirs: t.additionalDirs,
        ...(convoPane ? { conversationPane: convoPane } : {}),
        ...(t.historicalSessionIds.length > 0 ? { historicalSessionIds: t.historicalSessionIds } : {}),
        ...(persistedLastKnown ? { lastKnownSessionId: persistedLastKnown } : {}),
        ...(t.bashResults.length > 0 ? { bashResults: t.bashResults } : {}),
        ...(t.pillColor ? { pillColor: t.pillColor } : {}),
        ...(t.pillIcon ? { pillIcon: t.pillIcon } : {}),
        ...(t.forkedFromSessionId ? { forkedFromSessionId: t.forkedFromSessionId } : {}),
        ...(t.worktree ? { worktree: t.worktree } : {}),
        ...(t.groupId ? { groupId: t.groupId } : {}),
        ...(t.groupPinned ? { groupPinned: true } : {}),
        ...(t.queuedPrompts.length > 0 ? { queuedPrompts: t.queuedPrompts } : {}),
        ...(t.contextTokens ? { contextTokens: t.contextTokens } : {}),
        // Persist contextWindow alongside contextTokens so the status-bar
        // denominator is correct after reload (B4). Without this the indicator
        // recomputes pct as N / picker-model-window, which diverges whenever the
        // model the engine ran differs from the user's picker selection.
        ...(t.contextWindow ? { contextWindow: t.contextWindow } : {}),
        ...(t.lastMessagePreview ? { lastMessagePreview: t.lastMessagePreview } : {}),
        ...(t.lastEventAt ? { lastEventAt: t.lastEventAt } : {}),
        ...(t.isTerminalOnly ? { isTerminalOnly: true } : {}),
        ...(isEngine ? { hasEngineExtension: true, engineProfileId: t.engineProfileId } : {}),
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
        // Content locality (schema v4): a non-dirty file with a real path
        // reloads byte-identically from disk on restore (useFileEditorContent
        // already re-reads), so its buffers are not duplicated into the tab
        // file. Dirty edits and scratch buffers (no path) are the only copy
        // and persist inline.
        files: dirState.files.map((f) => {
          const reloadable = !f.isDirty && !!f.filePath
          return {
            filePath: f.filePath,
            fileName: f.fileName,
            content: reloadable ? '' : f.content,
            savedContent: reloadable ? '' : f.savedContent,
            isDirty: f.isDirty,
            isReadOnly: f.isReadOnly,
            isPreview: f.isPreview,
          }
        }),
      }
    }
  }

  const { isExpanded, fileEditorOpenDirs, editorGeometry, planGeometry, agentDetailGeometry } = useSessionStore.getState()

  let activeTabIndex: number | null = null
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i].id === activeTabId) { activeTabIndex = i; break }
  }

  const data: PersistedTabState = {
    schemaVersion: SPLIT_SCHEMA_VERSION,
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

  // External content files ride the same tick (change-tracked per tab), so
  // the thin manifest's hasExternalContent markers and the content files can
  // never drift by more than one debounce window.
  persistExternalContent(useSessionStore)

  // Owner sync push (mirror-store architecture): tab metadata does not ride
  // normalized events, so the owner publishes the same persisted snapshot to
  // the main process, which caches it and forwards it to the ATV mirror.
  // Live statuses ride ALONGSIDE (they are runtime state, not persisted to
  // disk) — without them the mirror would hydrate every tab as idle and the
  // workspace indicator would miss running conversations.
  window.ion.atvPublishTabsSync?.({
    ...data,
    liveTabStatus: Object.fromEntries(tabs.map((t) => [t.id, t.status])),
  })

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
  const { tabs, autoRecoverStuckTab } = useSessionStore.getState()
  for (const t of tabs) {
    if (t.status !== 'running' && t.status !== 'connecting') continue
    if (!t.activeRequestId) continue
    if (t.lastEventAt === null) continue
    if (now - t.lastEventAt <= thresholdMs) continue
    // Auto-heal: recreate the engine session in-process and resubmit the last
    // prompt so the work continues without user involvement (the user expected
    // background work to keep running). Bounded internally; falls back to a
    // plain reset + honest message after the attempt cap. This replaces the old
    // behavior of aborting and telling the user to "resume" — which they could
    // not meaningfully do, and which abandoned the work.
    autoRecoverStuckTab(t.id)
  }
}

export function setupPersistence(useSessionStore: Store): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  useSessionStore.subscribe((state, prev) => {
    // Skip all saves while the tab-restoration loop is running. Each per-tab
    // setState during rehydration fires this subscriber, but the partial state
    // (1..N-1 tabs loaded) always trips the GUARD (on-disk has N tabs, incoming
    // has fewer) producing a chain of "refusing save" rejections. The GUARD
    // remains as a backstop; this flag prevents the storm at the source.
    // rehydrating is cleared alongside tabsReady=true after the loop completes.
    if (state.rehydrating) return

    if (state.tabs !== prev.tabs || state.activeTabId !== prev.activeTabId || state.fileEditorStates !== prev.fileEditorStates || state.isExpanded !== prev.isExpanded || state.fileEditorOpenDirs !== prev.fileEditorOpenDirs || state.editorGeometry !== prev.editorGeometry || state.planGeometry !== prev.planGeometry || state.agentDetailGeometry !== prev.agentDetailGeometry || state.terminalPanes !== prev.terminalPanes || state.conversationPanes !== prev.conversationPanes) {
      // Flush immediately when permissionDenied changes on any tab — this
      // state must survive a crash or force-quit (e.g. the desktop is killed
      // while an engine run is in progress and the AskUserQuestion / ExitPlanMode
      // denial is never written to the conversation file). Per-conversation
      // permissionDenied now lives on the instance for EVERY tab (all tabs
      // use their `main` instance), so the single conversationPanes scan below covers
      // every tab uniformly.
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

      // Flush immediately when any tab captures or updates its conversationId.
      // Two cases require immediate persist:
      //   1. First capture: tab goes from no conversationId → sessionId (new session or
      //      first engine status event). The debounce creates a crash window here.
      //   2. Changed sessionId: engine restarts mid-conversation and emits a new sessionId
      //      (engine tab restart, reconnect). The prior sessionId was written on the debounced
      //      timer; if the engine crashes between the old and new id, the tab recovers to the
      //      old conversation. Writing immediately closes that window.
      // For all tab types, __ionForceFlushTabs (event-slice.ts, session_init handler)
      // also fires on sessionId capture, providing a second guarantee. The subscriber
      // here acts as a backstop when __ionForceFlushTabs isn't registered yet at startup.
      const conversationIdCaptured =
        state.tabs !== prev.tabs && state.tabs.some((t, i) => {
          const p = prev.tabs[i]
          return p && t.id === p.id && t.conversationId !== p.conversationId && !!t.conversationId
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

  // Publish one tabs snapshot as soon as restoration completes, so an ATV
  // mirror opened before the first user-driven persist still hydrates
  // (view readiness: the mirror's boot pull must find a snapshot).
  const unsubReady = useSessionStore.subscribe((state, prev) => {
    if (state.tabsReady && !prev.tabsReady) {
      persistTabs(useSessionStore)
      unsubReady()
    }
  })

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
