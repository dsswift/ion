import { create } from 'zustand'
import type { TerminalPaneState, ConversationPane } from '../../shared/types'
import { serializeTerminalBuffer } from '../components/TerminalInstance'
import type { State, StoreSet, StoreGet } from './session-store-types'
import type { ResourceItem } from '../../shared/types-engine'
import { resourceIdentity, resourceMatchesIdentity } from '../../shared/resource-identity'
import { markResourcesRead } from './slices/resource-slice'
import { makeLocalTab, initialModelOverride, initialThinkingEffort } from './session-store-helpers'
import { makeMainPane } from './conversation-instance'
import { createTabSlice } from './slices/tab-slice'
import { createCloseIntentSlice } from './slices/close-intent-slice'
import { createResumeSlice } from './slices/resume-slice'
import { createForkSlice } from './slices/resume-slice-fork'
import { createExpandSlice } from './slices/expand-slice'
import { createInboxSlice } from './slices/inbox-slice'
import { createTerminalSlice } from './slices/terminal-slice'
import { createFileExplorerSlice } from './slices/file-explorer-slice'
import { createFileEditorSlice } from './slices/file-editor-slice'
import { createDirectorySlice } from './slices/directory-slice'
import { createWorktreeSlice } from './slices/worktree-slice'
import { createWorktreeInventorySlice } from './slices/worktree-inventory-slice'
import { createWorktreePipelineSlice } from './slices/worktree-pipeline-slice'
import { createBenchSlice } from './slices/bench-slice'
import { createBenchAssemblySlice } from './slices/bench-slice-assembly'
import { createBenchVerificationSlice } from './slices/bench-verification-slice'
import { createGitConflictSlice } from './slices/git-conflict-slice'
import { createConflictOperationSlice } from './slices/conflict-operation-slice'
import { trackWorkspaceActions } from './session-store-workspace-operation-ledger'
import { setupStudioWorktreeSync } from './session-store-worktree-sync'
import { createAttachmentsSlice } from './slices/attachments-slice'
import { createPermissionsSlice } from './slices/permissions-slice'
import { createSendSlice } from './slices/send-slice'
import { createDispatchAbortSlice } from './slices/dispatch-abort-slice'
import { createBackgroundTaskSlice } from './slices/background-task-slice'
import { createEventSlice } from './slices/event-slice'
import { reportAutoFixCompletion } from './slices/event-slice-auto-fix-lifecycle'
import { createEngineSlice } from './slices/engine-slice'
import { createImplementSlice } from './slices/implement-slice'
import { setupPersistence } from './session-store-persistence'
import { startAutoSettleSweep } from './auto-settle-sweep'
import { usePreferencesStore } from '../preferences'
import { isMirrorWindow } from '../lib/window-role'

export { isTextFile, editorDirForTab } from './session-store-helpers'
export { AVAILABLE_MODELS, getModelDisplayLabel } from './model-labels'
export type { FileEditorTab, FileEditorDirState } from './session-store-types'

const initialTab = makeLocalTab()

// Seed the initial tab's single `main` conversation instance eagerly (2A):
// every tab — normal or engine — owns at least one ConversationInstance in
// conversationPanes from creation, so no consumer ever sees a missing pane.
const initialEnginePanes = new Map<string, ConversationPane>([
  [initialTab.id, makeMainPane({ modelOverride: initialModelOverride(), modelOverrideSource: initialModelOverride() ? 'automatic' : null, thinkingEffort: initialThinkingEffort(initialModelOverride()) })],
])

const initialState = {
  tabs: [initialTab],
  settledHistory: [],
  activeTabId: initialTab.id,
  isExpanded: false,
  staticInfo: null,
  gitPanelOpen: false,
  inboxPanelOpen: false,
  // Null = use the default height, which is also the floor for a drag.
  statusDrawerOpen: false,
  statusDrawerDispatchId: null,
  dispatchSplit: null,
  terminalOpenTabIds: new Set<string>(),
  terminalActiveTabIds: new Set<string>(),
  terminalPendingCommands: new Map<string, string>(),
  terminalPanes: new Map<string, TerminalPaneState>(),
  terminalTallTabId: null,
  terminalBigScreenTabId: null,
  fileExplorerOpenDirs: new Set<string>(),
  fileExplorerRootCollapsed: new Set<string>(),
  fileExplorerStates: new Map(),
  fileEditorOpenDirs: new Set<string>(),
  fileEditorFocused: true,
  fileEditorStates: new Map(),
  editorGeometry: { x: 60, y: 80, w: 680, h: 480 },
  planGeometry: { x: 60, y: 80, w: 720, h: 420 },
  resourceViewerGeometry: { x: 80, y: 100, w: 720, h: 420 },
  agentDetailGeometry: { x: 60, y: 80, w: 600, h: 500 },
  tabsReady: false,
  startupReady: false,
  startupError: null,
  rehydrating: false,
  initProgress: null,
  worktreeUncommittedMap: new Map(),
  worktreeInventory: new Map(),
  benchWorkspaces: new Map(),
  benchSourceTips: new Map(),
  benchRetired: new Map(),
  gitConflictAlerts: new Map(),
  worktreePipeline: null,
  workspaceOperationLedger: new Map(),
  engineWorkingMessages: new Map(),
  engineNotifications: new Map(),
  engineDialogs: new Map(),
  enginePinnedPrompt: new Map(),
  conversationPanes: initialEnginePanes,
  engineModelFallbacks: new Map<string, { requestedModel: string; fallbackModel: string; reason: string; at: number }>(),
  resources: {} as Record<string, import('../../shared/types-engine').ResourceItem[]>,
  resourceSubscriptions: {} as Record<string, string>,
  readResourceIds: new Set<string>(),
  dispatchActivity: {} as Record<string, import('../../shared/types').Message[]>,
  tallViewTabId: null,
  suspendedTallTabId: null,
  scrollToBottomCounter: 0,
  settingsOpen: false,
  settingsInitialTab: null,
  openFloatingPanelCount: 0,
}

export const useSessionStore = create<State>((set, get) => {
  const _set = set as StoreSet
  const _get = get as StoreGet
  return {
    ...initialState,
    ...createTabSlice(_set, _get),
    ...createCloseIntentSlice(_set, _get),
    ...createResumeSlice(_set, _get),
    ...createForkSlice(_set, _get),
    ...createExpandSlice(_set, _get),
    ...createInboxSlice(_set, _get),
    ...createTerminalSlice(_set, _get),
    ...createFileExplorerSlice(_set, _get),
    ...createFileEditorSlice(_set, _get),
    ...createDirectorySlice(_set, _get),
    ...trackWorkspaceActions(_set, {
      ...createWorktreeSlice(_set, _get),
      ...createWorktreeInventorySlice(_set, _get),
      ...createWorktreePipelineSlice(_set, _get),
      ...createBenchSlice(_set, _get),
      ...createBenchAssemblySlice(_set, _get),
      ...createBenchVerificationSlice(_set, _get),
      ...createGitConflictSlice(_set, _get),
      ...createConflictOperationSlice(_set, _get),
    }),
    ...createAttachmentsSlice(_set, _get),
    ...createPermissionsSlice(_set, _get),
    ...createSendSlice(_set, _get),
    ...createDispatchAbortSlice(_set, _get),
    ...createBackgroundTaskSlice(_set, _get),
    ...createEventSlice(_set, _get),
    reportAutoFixCompletion: (tabId, evidence) => reportAutoFixCompletion(tabId, evidence, _get),
    ...createEngineSlice(_set, _get),
    ...createImplementSlice(_set, _get),
    markResourceRead: (resourceId: string) => {
      set((state) => {
        const updated = new Set(state.readResourceIds)
        updated.add(resourceId)
        return { readResourceIds: updated }
      })
    },
    markAllResourcesRead: (items: ResourceItem[]) => {
      // Batch the local read-state update into a single transition.
      set((state) => markResourcesRead(state, items.map(resourceIdentity)))
      // Fan the read state out per item through the engine's resource broker
      // (mark_read delta) so other subscribers — notably iOS — converge. This
      // reuses the exact per-item mechanism the panel already uses on open,
      // which also persists the read state on the desktop main process.
      for (const item of items) {
        window.ion?.markResourceRead?.(item.kind, item.id, item.producer)
      }
    },
    deleteResource: (kind: string, resourceId: string, producer?: string) => {
      set((state) => {
        const current = state.resources[kind] ?? []
        return {
          resources: { ...state.resources, [kind]: current.filter((item) => !resourceMatchesIdentity(item, resourceId, producer)) },
        }
      })
    },
  } as State
})

;(window as any).__Ion_SESSION_STORE__ = useSessionStore
;(window as any).__Ion_PREFERENCES_STORE__ = usePreferencesStore
;(window as any).__serializeTerminalBuffer = serializeTerminalBuffer

// The Studio mirror window never persists: the overlay renderer is the single
// writer for tabs/settings (single-writer rule of the mirror-store
// architecture). The mirror also skips the stuck-tab watchdog and the
// __ionForceFlushTabs global (both live inside setupPersistence) — healing
// and flushing are owner duties.
if (!isMirrorWindow()) {
  setupPersistence(useSessionStore)
  startAutoSettleSweep(useSessionStore)
  setupStudioWorktreeSync(useSessionStore)
}
