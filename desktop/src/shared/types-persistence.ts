import type { TerminalInstance, WorktreeInfo, Attachment } from './types-session'
import type { ConversationRef } from './types-engine'

// ─── Schema version constants ───

/**
 * Schema version after the split migration (single-instance tabs).
 * Canonical definition — imported from here by both `main/tab-migration-split`
 * (re-exported for backwards compat) and renderer code.
 */
export const SPLIT_SCHEMA_VERSION = 3

/**
 * Schema version after the externalize migration (thin manifest + per-tab
 * content files). Canonical definition — imported from here by both
 * `main/tab-migration-externalize` (re-exported for backwards compat) and
 * renderer code. The renderer stamps this version on every save, so the
 * migration's idempotency guard fires correctly on the next startup.
 */
export const EXTERNALIZE_SCHEMA_VERSION = 4

// ─── Persisted Tab State ───

/**
 * The reason a new engine session id was cut for a tab. This is the policy that
 * makes session-cuts auditable and makes restart-fragmentation impossible: ONLY
 * an explicit checkpoint appends a ledger entry. A process/engine restart never
 * cuts a new id — it resumes `currentSessionId`.
 *
 *  - `clear`      — the user cleared context (in-place `/clear`, same id; or the
 *                   Implement-plan clear-context cut, which mints a new id).
 *  - `compaction` — a compaction event split the session (optional: today
 *                   compaction is in-place and does NOT append; reserved for a
 *                   future compaction-driven split).
 *  - `fork`       — a tree-navigation fork branched the conversation.
 *  - `unknown`    — migration backfill for pre-ledger `conversationIds[]` chains
 *                   whose original cut reason was not recorded.
 */
export type SessionCutReason = 'clear' | 'compaction' | 'fork' | 'unknown'

/**
 * One entry in a tab's session ledger: a single engine conversation file that
 * the tab has owned over its life. The newest entry's id is the tab's
 * `currentSessionId`. Older entries remain so the renderer can concatenate the
 * full scrollback across clears/compaction even though the agent only ever sees
 * the current session's context.
 */
export interface SessionLedgerEntry {
  /** The engine conversation id (a `~/.ion/conversations/<id>.*` file). */
  id: string
  /** Why this session was cut from its predecessor. */
  reason: SessionCutReason
  /** Unix ms when the entry was appended. */
  createdAt: number
  /** The id this session descends from (the prior current id), when known.
   *  Mirrors the engine's on-disk `parentId` so the chain is navigable. */
  parentId?: string
}

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
  /**
   * Schema v4: true when this instance's scrollback lives in an external
   * content file (`~/.ion/tab-content/<tabId>.json`) instead of inline
   * `messages`. Set by the serializer whenever it externalizes and by the
   * v3→v4 migration when it strips inline messages. The restore path uses
   * this explicit marker — never file-presence guessing — to decide whether
   * to lazy-load the content file. Absent/false means the instance is
   * count-only (every row reloads from the engine conversation store).
   */
  hasExternalContent?: boolean
  /** Scrollback. Plain tabs persist message content here too (the old shape
   *  persisted only a count for plain tabs and full messages for engine tabs;
   *  the unified shape persists messages uniformly, gated by size as before). */
  messages?: Array<{ role: string; content: string; toolName?: string; toolId?: string; toolInput?: string; toolStatus?: string; timestamp: number; dedupKey?: string; planFilePath?: string; slashCommand?: string; slashArgs?: string; slashSource?: string; attachments?: Attachment[] }>
  /** Blank-tab / lazy-load proxy when messages are omitted. */
  messageCount?: number
  modelOverride?: string | null
  sessionModel?: string | null
  permissionMode?: 'auto' | 'plan'
  permissionDenied?: { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null
  /**
   * @deprecated Pre-ledger session chain. Read on load and migrated into
   * `sessions[]` (reason `unknown`). Still WRITTEN alongside `sessions` for one
   * release so a downgrade keeps resuming; new readers should prefer
   * `currentSessionId` / `sessions`.
   */
  conversationIds?: string[]
  /**
   * The tab's session ledger: every engine conversation it has owned, oldest
   * first, newest last. The newest entry's id == `currentSessionId`. Only a
   * checkpoint cut appends; restart never does. Absent on legacy files (the
   * loader derives it from `conversationIds`).
   */
  sessions?: SessionLedgerEntry[]
  /**
   * The live engine session id the tab resumes on restart. The newest ledger
   * entry's id. Persisted explicitly so restore resolves the resume target
   * without walking the ledger and so a restart provably cannot append.
   */
  currentSessionId?: string
  draftInput?: string
  agentStates?: Array<{ name: string; id?: string; status: string; metadata?: Record<string, any> }>
  dispatchTelemetry?: Array<{ dispatchId: string; dispatchAgent: string; dispatchSessionId: string; dispatchModel: string; dispatchTask: string; dispatchDepth: number; dispatchParentId: string }>
  planFilePath?: string | null
}

/** Unified persisted pane: the instances for a tab + which is active. */
export interface PersistedConversationPane {
  instances: PersistedConversationInstance[]
  activeInstanceId: string | null
}

export interface PersistedTab {
  /**
   * Durable tab identity. The desktop session key IS the bare tabId
   * (shared/session-key.ts → sessionKey() returns the tabId verbatim), and the
   * engine treats that key as opaque. Before this field existed the tabId lived
   * only in renderer memory, so every cold restart minted a fresh one — handing
   * the engine a NEW session key for the same logical tab. The engine's
   * key→conversationId binding store (session-bindings.json) then missed, the
   * engine pre-minted an empty conversation, and the tab's history fragmented
   * across N disjoint files. Persisting the tabId makes the session key durable:
   * restore reuses it, the binding store hits, and the tab keeps ONE session id
   * across every restart. Optional for back-compat — legacy files have no `id`;
   * the loader mints one on first restore and persists it from then on.
   */
  id?: string
  conversationId: string | null
  historicalSessionIds?: string[]
  lastKnownSessionId?: string
  title: string
  customTitle: string | null
  workingDirectory: string
  hasChosenDirectory: boolean
  additionalDirs: string[]
  /**
   * @deprecated Legacy tab-level permission mode field. Written by persistence
   * before WI-002; read by restoration paths as a fallback when the persisted
   * conversation instance has no `permissionMode`. New persistence no longer
   * writes this field — the mode lives on `PersistedConversationInstance`.
   */
  permissionMode?: 'auto' | 'plan'
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
  /** Persisted contextWindow denominator (from context_breakdown event) so the
   *  status-bar percent is correct after reload without requiring a new run. */
  contextWindow?: number | null
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
   * fields + `engine*` maps); 2 means the unified `conversationPane` shape
   * (`tab-migration-unify.ts`); 3 means single-instance tabs
   * (`tab-migration-split.ts`); 4 means externalized content — instance
   * scrollback lives in per-tab content files and non-dirty editor buffers
   * reload from disk (`tab-migration-externalize.ts`). The loader runs the
   * migrations in order at the LOAD_TABS chokepoint.
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

/**
 * One instance's externalized scrollback: the payload of
 * `~/.ion/tab-content/<tabId>.json` (schema v4). One file per tab — the
 * single-instance-per-tab model makes the durable tab id the natural,
 * collision-free content key (runtime instance ids all normalize to 'main').
 */
export interface ExternalInstanceContent {
  /** The durable tab id this content belongs to (also the file name). */
  tabId: string
  /** The persisted instance id the messages were stripped from. */
  instanceId: string
  schemaVersion: number
  messages: NonNullable<PersistedConversationInstance['messages']>
}
