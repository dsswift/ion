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
  modelOverride?: string | null
  forkedFromSessionId?: string | null
  worktree?: WorktreeInfo | null
  groupId?: string | null
  /** When true, suppresses auto-group movement for this tab. Default false on load for back-compat. */
  groupPinned?: boolean
  contextTokens?: number | null
  queuedPrompts?: string[]
  /** Unsent text typed into the input bar; restored on relaunch. Absent when empty. */
  draftInput?: string
  /** Per-engine-instance unsent input text, keyed by `instanceId`. Only non-empty values. */
  engineDrafts?: Record<string, string>
  isTerminalOnly?: boolean
  isEngine?: boolean
  engineProfileId?: string | null
  engineInstances?: EngineInstance[]
  engineMessages?: Record<string, Array<{ role: string; content: string; toolName?: string; toolId?: string; toolInput?: string; toolStatus?: string; timestamp: number }>>
  engineAgentStates?: Record<string, Array<{ name: string; status: string; metadata?: Record<string, any> }>>
  /**
   * Most recent engine conversation ID per engine instance, keyed by
   * `instanceId`. Used on restoration to resume the engine session
   * with continuity instead of starting a fresh conversation file.
   *
   * Why per-instance: a single engine tab hosts multiple independent
   * sub-conversations (one per instance), each backed by its own
   * `~/.ion/conversations/<sessionId>.jsonl`. Persisting the parent
   * `tab.conversationId` alone wasn't enough — three instances under
   * the same tab would collide on a single ID. The first version of
   * the engine-tab persistence missed this; the field is added in
   * the same change that introduces per-instance permission denials.
   *
   * Engine continuity also matters for `useEnginePermissionDenialBackfill`:
   * the hook needs to know which conversation file to read to recover
   * a pending AskUserQuestion / ExitPlanMode card after a restart.
   */
  engineSessionIds?: Record<string, string>
  /**
   * Per-engine-instance AskUserQuestion / ExitPlanMode denials, keyed by
   * `instanceId`. Mirrors the runtime `enginePermissionDenied` map (which
   * is keyed by the compound `${tabId}:${instanceId}`). Only instances
   * with a non-null pending denial appear here. Restored on relaunch so
   * a crash mid-question doesn't lose the card.
   */
  engineDenials?: Record<string, { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> }>
  terminalInstances?: TerminalInstance[]
  terminalBuffers?: Record<string, string>
  /** Wall-clock ms of the most recent engine event for this tab. Persisted so
   *  the tab strip can show relative activity ("2m") across app restarts. */
  lastEventAt?: number | null
  /** Short single-line preview of the last visible message (~80 chars). */
  lastMessagePreview?: string | null
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
