import type { TerminalInstance, WorktreeInfo } from './types-session'
import type { EngineInstance } from './types-engine'

// ─── Persisted Tab State ───

export interface PersistedTab {
  conversationId: string | null
  historicalSessionIds?: string[]
  lastKnownSessionId?: string
  title: string
  customTitle: string | null
  workingDirectory: string
  hasChosenDirectory: boolean
  additionalDirs: string[]
  permissionMode: 'auto' | 'plan'
  permissionDenied?: { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null
  planFilePath?: string | null
  bashResults?: Array<{ command: string; stdout: string; stderr: string }>
  pillColor?: string | null
  pillIcon?: string | null
  forkedFromSessionId?: string | null
  worktree?: WorktreeInfo | null
  groupId?: string | null
  contextTokens?: number | null
  queuedPrompts?: string[]
  isTerminalOnly?: boolean
  isEngine?: boolean
  engineProfileId?: string | null
  engineInstances?: EngineInstance[]
  engineMessages?: Record<string, Array<{ role: string; content: string; toolName?: string; toolId?: string; toolStatus?: string; timestamp: number }>>
  engineAgentStates?: Record<string, Array<{ name: string; status: string; metadata?: Record<string, any> }>>
  terminalInstances?: TerminalInstance[]
  terminalBuffers?: Record<string, string>
}

export interface PersistedEditorFile {
  filePath: string | null
  fileName: string
  content: string
  savedContent: string
  isDirty: boolean
  isReadOnly: boolean
  isPreview: boolean
}

export interface PersistedEditorState {
  /** Index of the active file in the files array (replaces activeFileId since IDs are regenerated) */
  activeFileIndex: number
  files: PersistedEditorFile[]
}

export interface PersistedTabState {
  activeSessionId: string | null
  /** Index of active tab in the tabs array (handles sessionless tabs) */
  activeTabIndex?: number | null
  tabs: PersistedTab[]
  /** Per-directory editor state. Key = working directory path */
  editorStates?: Record<string, PersistedEditorState>
  /** Whether the conversation view was expanded */
  isExpanded?: boolean
  /** Directories that had the file editor open */
  editorOpenDirs?: string[]
  /** @deprecated Indices into tabs array for tabs that had the file editor open */
  editorOpenSessionIds?: number[]
  /** Global file editor window position and size */
  editorGeometry?: { x: number; y: number; w: number; h: number }
  /** Global plan preview window position and size */
  planGeometry?: { x: number; y: number; w: number; h: number }
}
