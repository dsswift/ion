import { create } from 'zustand'
import type { TerminalPaneState, EnginePaneState, Message } from '../../shared/types'
import { serializeTerminalBuffer } from '../components/TerminalInstance'
import type { State, StoreSet, StoreGet } from './session-store-types'
import { makeLocalTab } from './session-store-helpers'
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

export { isTextFile, editorDirForTab } from './session-store-helpers'
export { AVAILABLE_MODELS, getModelDisplayLabel } from './model-labels'
export type { FileEditorTab, FileEditorDirState } from './session-store-types'

const initialTab = makeLocalTab()

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
  tabsReady: false,
  backend: 'api' as const,
  worktreeUncommittedMap: new Map(),
  engineAgentStates: new Map(),
  engineStatusFields: new Map(),
  engineWorkingMessages: new Map(),
  engineNotifications: new Map(),
  engineDialogs: new Map(),
  enginePinnedPrompt: new Map(),
  engineUsage: new Map(),
  engineConversationIds: new Map<string, string[]>(),
  enginePanes: new Map<string, EnginePaneState>(),
  engineMessages: new Map<string, Message[]>(),
  tallViewTabId: null,
  scrollToBottomCounter: 0,
  settingsOpen: false,
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
  } as State
})

;(window as any).__Ion_SESSION_STORE__ = useSessionStore
;(window as any).__serializeTerminalBuffer = serializeTerminalBuffer

setupPersistence(useSessionStore)
