import { create } from 'zustand'
import type { TerminalPaneState, ConversationPane, Message } from '../../shared/types'
import { serializeTerminalBuffer } from '../components/TerminalInstance'
import type { State, StoreSet, StoreGet } from './session-store-types'
import { makeLocalTab, initialModelOverride } from './session-store-helpers'
import { makeMainPane } from './conversation-instance'
import { parseSessionKey } from '../../shared/session-key'
import { createTabSlice } from './slices/tab-slice'
import { createResumeSlice } from './slices/resume-slice'
import { createExpandSlice } from './slices/expand-slice'
import { createTerminalSlice } from './slices/terminal-slice'
import { createFileExplorerSlice } from './slices/file-explorer-slice'
import { createFileEditorSlice } from './slices/file-editor-slice'
import { createDirectorySlice } from './slices/directory-slice'
import { createWorktreeSlice } from './slices/worktree-slice'
import { createAttachmentsSlice } from './slices/attachments-slice'
import { createPermissionsSlice } from './slices/permissions-slice'
import { createSendSlice } from './slices/send-slice'
import { createEventSlice } from './slices/event-slice'
import { createEngineSlice } from './slices/engine-slice'
import { createEngineEventSlice } from './slices/engine-event-slice'
import { setupPersistence } from './session-store-persistence'
import { usePreferencesStore } from '../preferences'

export { isTextFile, editorDirForTab } from './session-store-helpers'
export { AVAILABLE_MODELS, getModelDisplayLabel } from './model-labels'
export type { FileEditorTab, FileEditorDirState } from './session-store-types'

const initialTab = makeLocalTab()

// Seed the initial tab's single `main` conversation instance eagerly (2A):
// every tab — normal or engine — owns at least one ConversationInstance in
// conversationPanes from creation, so no consumer ever sees a missing pane.
const initialEnginePanes = new Map<string, ConversationPane>([
  [initialTab.id, makeMainPane({ modelOverride: initialModelOverride() })],
])

const initialState = {
  tabs: [initialTab],
  activeTabId: initialTab.id,
  isExpanded: false,
  staticInfo: null,
  gitPanelOpen: false,
  terminalOpenTabIds: new Set<string>(),
  terminalPendingCommands: new Map<string, string>(),
  terminalPanes: new Map<string, TerminalPaneState>(),
  terminalTallTabId: null,
  terminalBigScreenTabId: null,
  fileExplorerOpenDirs: new Set<string>(),
  fileExplorerStates: new Map(),
  fileEditorOpenDirs: new Set<string>(),
  fileEditorFocused: true,
  fileEditorStates: new Map(),
  editorGeometry: { x: 60, y: 80, w: 680, h: 480 },
  planGeometry: { x: 60, y: 80, w: 720, h: 420 },
  briefingGeometry: { x: 80, y: 100, w: 720, h: 420 },
  agentDetailGeometry: { x: 60, y: 80, w: 600, h: 500 },
  tabsReady: false,
  initProgress: null,
  backend: 'api' as const,
  worktreeUncommittedMap: new Map(),
  engineWorkingMessages: new Map(),
  engineNotifications: new Map(),
  engineDialogs: new Map(),
  enginePinnedPrompt: new Map(),
  engineUsage: new Map(),
  conversationPanes: initialEnginePanes,
  engineModelFallbacks: new Map<string, { requestedModel: string; fallbackModel: string; reason: string; at: number }>(),
  resources: {} as Record<string, import('../../shared/types-engine').ResourceItem[]>,
  resourceSubscriptions: {} as Record<string, string>,
  readResourceIds: new Set<string>(),
  tallViewTabId: null,
  scrollToBottomCounter: 0,
  settingsOpen: false,
  settingsInitialTab: null,
}

export const useSessionStore = create<State>((set, get) => {
  const _set = set as StoreSet
  const _get = get as StoreGet
  return {
    ...initialState,
    ...createTabSlice(_set, _get),
    ...createResumeSlice(_set, _get),
    ...createExpandSlice(_set, _get),
    ...createTerminalSlice(_set, _get),
    ...createFileExplorerSlice(_set, _get),
    ...createFileEditorSlice(_set, _get),
    ...createDirectorySlice(_set, _get),
    ...createWorktreeSlice(_set, _get),
    ...createAttachmentsSlice(_set, _get),
    ...createPermissionsSlice(_set, _get),
    ...createSendSlice(_set, _get),
    ...createEventSlice(_set, _get),
    ...createEngineSlice(_set, _get),
    ...createEngineEventSlice(_set, _get),
    markResourceRead: (resourceId: string) => {
      set((state) => {
        const updated = new Set(state.readResourceIds)
        updated.add(resourceId)
        return { readResourceIds: updated }
      })
    },
    deleteResource: (kind: string, resourceId: string) => {
      set((state) => {
        const current = state.resources[kind] ?? []
        return {
          resources: { ...state.resources, [kind]: current.filter(r => r.id !== resourceId) },
        }
      })
    },
  } as State
})

;(window as any).__Ion_SESSION_STORE__ = useSessionStore
;(window as any).__Ion_PREFERENCES_STORE__ = usePreferencesStore
;(window as any).__Ion_resolveEngineModel = (compoundKey: string): string => {
  const s = useSessionStore.getState()
  const prefs = usePreferencesStore.getState()
  const { tabId, instanceId } = parseSessionKey(compoundKey)
  const pane = s.conversationPanes.get(tabId)
  const inst = pane?.instances.find((i) => i.id === instanceId)
  return inst?.modelOverride || prefs.engineDefaultModel || prefs.preferredModel || 'claude-sonnet-4-6'
}
;(window as any).__serializeTerminalBuffer = serializeTerminalBuffer

setupPersistence(useSessionStore)
