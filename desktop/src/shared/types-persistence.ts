import type { TerminalInstance, WorktreeInfo } from './types-session'
import type { ConversationRef } from './types-engine'

// ─── Persisted Tab State ───

/**
 * Unified persisted conversation instance. Every tab — plain or
 * extension-hosted — persists its conversation state as one or more of these
 * inside `PersistedTab.conversationPane`. A plain conversation has exactly one
 * instance with the `main` sentinel id; an extension-hosted conversation has
 * one per sub-conversation.
 *
 * This replaces the old split persisted shape (plain tabs stored flat fields
 * like `messageCount`/`permissionDenied`/`draftInput` directly on the tab;
 * extension-hosted tabs stored parallel `engine*` maps keyed by instanceId).
 * The migration (`tab-migration-unify.ts`) converts both old shapes into this
 * one. The legacy fields remain on `PersistedTab` as deprecated READ-only
 * inputs to the migration; current persistence writes only `conversationPane`.
 */
export interface PersistedConversationInstance {
  id: string
  label: string
  /** Scrollback. Plain tabs persist message content here too (the old shape
   *  persisted only a count for plain tabs and full messages for engine tabs;
   *  the unified shape persists messages uniformly, gated by size as before). */
  messages?: Array<{ role: string; content: string; toolName?: string; toolId?: string; toolInput?: string; toolStatus?: string; timestamp: number; dedupKey?: string; planFilePath?: string; slashCommand?: string; slashArgs?: string; slashSource?: string }>
  /** Blank-tab / lazy-load proxy when messages are omitted. */
  messageCount?: number
  modelOverride?: string | null
  sessionModel?: string | null
  permissionMode?: 'auto' | 'plan'
  permissionDenied?: { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null
  conversationIds?: string[]
  draftInput?: string
  agentStates?: Array<{ name: string; id?: string; status: string; metadata?: Record<string, any> }>
  planFilePath?: string | null
  forkedFromConversationIds?: string[] | null
}

/** Unified persisted pane: the instances for a tab + which is active. */
export interface PersistedConversationPane {
  instances: PersistedConversationInstance[]
  activeInstanceId: string | null
}

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
  /**
   * Unified conversation state for this tab (the post-migration shape). When
   * present, the loader reads conversation instances from here and IGNORES the
   * legacy flat fields / `engine*` maps below. Written by current persistence;
   * populated for legacy files by `tab-migration-unify.ts`.
   */
  conversationPane?: PersistedConversationPane
  /**
   * True when the conversation hosts an engine extension. Written by current
   * persistence. The legacy `isEngine` key (below) is still READ by the loader
   * for on-disk back-compat with tabs.json files written before the rename.
   */
  hasEngineExtension?: boolean
  /** @deprecated Legacy on-disk key for `hasEngineExtension`. Read-only — the
   *  loader/migration accepts it; persistence writes `hasEngineExtension`. */
  isEngine?: boolean
  engineProfileId?: string | null
  engineInstances?: ConversationRef[]
  engineMessages?: Record<string, Array<{ role: string; content: string; toolName?: string; toolId?: string; toolInput?: string; toolStatus?: string; timestamp: number; dedupKey?: string }>>
  engineAgentStates?: Record<string, Array<{ name: string; id?: string; status: string; metadata?: Record<string, any> }>>
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
  /** Per-engine-instance model override, keyed by `instanceId`. Restored on
   *  relaunch so the engine session resumes with the same model the user had
   *  selected (instead of falling back to the hardcoded default). */
  engineModelOverrides?: Record<string, string>
  /**
   * Per-engine-instance permission mode, keyed by `instanceId`.
   * Restored on relaunch so each subtab resumes with the correct
   * plan/auto mode independently. Follows the same shape as
   * `engineDenials` and `engineModelOverrides`.
   */
  enginePermissionModes?: Record<string, 'auto' | 'plan'>
  /** Per-engine-instance forked conversation ID chain, keyed by `instanceId`.
   *  Set after rewind so the next prompt can inject prior-conversation context.
   *  Persisted so the rewind state survives app restart. */
  engineForkedFromConversationIds?: Record<string, string[]>
  terminalInstances?: TerminalInstance[]
  terminalBuffers?: Record<string, string>
  /** Wall-clock ms of the most recent engine event for this tab. Persisted so
   *  the tab strip can show relative activity ("2m") across app restarts. */
  lastEventAt?: number | null
  /** Short single-line preview of the last visible message (~80 chars). */
  lastMessagePreview?: string | null
  /** Persisted message count for blank-tab detection when messages are lazily loaded. */
  messageCount?: number
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
  /**
   * Schema version. Absent or < 2 means the legacy split shape (flat plain-tab
   * fields + `engine*` maps); 2 means the unified `conversationPane` shape. The
   * loader runs `tab-migration-unify.ts` when it sees a pre-2 file.
   */
  schemaVersion?: number
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
  /** Global agent detail popup position and size */
  agentDetailGeometry?: { x: number; y: number; w: number; h: number }
}
