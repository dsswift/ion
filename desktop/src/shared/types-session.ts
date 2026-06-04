import type { UsageData } from './types-events'

// ─── Tab Grouping ───

export const DEFAULT_TAB_GROUP_LABELS = ['Planning', 'On Deck', 'In Progress', 'Testing'] as const

export type TabGroupMode = 'off' | 'auto' | 'manual'

export interface TabGroup {
  id: string          // nanoid
  label: string       // user-provided name (manual) or dir name (auto)
  isDefault: boolean  // manual mode: where new tabs land
  order: number       // position in strip
  collapsed: boolean  // whether the group shows as a single pill
}

// ─── Tab State Machine (v2 — from execution plan) ───

export type TabStatus = 'connecting' | 'idle' | 'running' | 'completed' | 'failed' | 'dead'

export interface PermissionRequest {
  questionId: string
  toolTitle: string
  toolDescription?: string
  toolInput?: Record<string, unknown>
  options: Array<{ optionId: string; kind?: string; label: string }>
}

export interface FileAttachment {
  id: string
  type: 'image' | 'file'
  name: string
  path: string
  mimeType?: string
  /** Base64 data URL for image previews */
  dataUrl?: string
  /** File size in bytes */
  size?: number
}

export interface PlanAttachment {
  id: string
  type: 'plan'
  name: string
  path: string
}

export type Attachment = FileAttachment | PlanAttachment

export interface TabState {
  id: string
  conversationId: string | null
  historicalSessionIds: string[]
  /** Most recent non-null conversationId; never cleared. Recovery fallback when conversationId is null. */
  lastKnownSessionId: string | null
  status: TabStatus
  activeRequestId: string | null
  /** Wall-clock ms of last engine-originated event for this tab. Drives the stuck-tab watchdog. Not persisted. */
  lastEventAt: number | null
  hasUnread: boolean
  currentActivity: string
  permissionQueue: PermissionRequest[]
  /** Fallback card when tools were denied and no interactive permission is available */
  permissionDenied: { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null
  attachments: FileAttachment[]
  /** Draft input text for this tab's input bar (scoped per-tab) */
  draftInput: string
  /** One-shot field: set by rewind, consumed by InputBar to pre-fill input, then cleared */
  pendingInput?: string
  messages: Message[]
  title: string
  /** User-provided custom tab name (overrides auto-generated title when set) */
  customTitle: string | null
  /** Last run's result data (cost, tokens, duration) */
  lastResult: RunResult | null
  /** Session metadata from init event */
  sessionModel: string | null
  modelOverride: string | null
  sessionTools: string[]
  sessionMcpServers: Array<{ name: string; status: string }>
  sessionSkills: string[]
  sessionVersion: string | null
  /** Prompts waiting behind the current run (display text only) */
  queuedPrompts: string[]
  /** Working directory for this tab's sessions */
  workingDirectory: string
  /** Whether the user explicitly chose a directory (vs. using default home) */
  hasChosenDirectory: boolean
  /** Extra directories accessible via --add-dir (session-preserving) */
  additionalDirs: string[]
  /** Per-tab permission mode: 'auto' auto-approves, 'plan' uses CLI plan mode */
  permissionMode: 'auto' | 'plan'
  /** Path to the last plan file produced during plan mode */
  planFilePath: string | null
  /** Pending bash command results to send as context with next prompt */
  bashResults: Array<{ command: string; stdout: string; stderr: string }>
  /** Whether a bash command is currently executing in this tab */
  bashExecuting: boolean
  /** ID of the currently executing bash command (for cancellation) */
  bashExecId: string | null
  /** Custom pill outline color (null = use theme default) */
  pillColor: string | null
  /** Custom pill icon shape (null = default circle dot) */
  pillIcon: string | null
  /** Session ID this tab was forked from (null if not a fork) */
  forkedFromSessionId: string | null
  /** True once a file-writing tool (Write, Edit, NotebookEdit, MultiEdit) completes successfully */
  hasFileActivity: boolean
  /** Worktree metadata when tab operates inside a managed worktree */
  worktree: WorktreeInfo | null
  /** True while waiting for the user to pick a source branch in the BranchPickerDialog */
  pendingWorktreeSetup: boolean
  /** Tab group assignment (null = ungrouped / auto-computed) */
  groupId: string | null
  /**
   * When true, suppresses autoGroupMovement for this tab.
   * Manual moves preserve the pin — the new group becomes the sticky anchor.
   * Toggle via right-click → "Pin to group" / "Unpin from group".
   */
  groupPinned: boolean
  /** Latest input_tokens from API response (total context sent to model) */
  contextTokens: number | null
  /** Engine-computed context usage percentage (accounts for model-specific context window) */
  contextPercent: number | null
  /** True while the engine is actively compacting context */
  isCompacting: boolean
  /** Terminal-focused tab with no conversation */
  isTerminalOnly: boolean
  /** Whether this tab runs an engine session instead of CLI backend */
  isEngine: boolean
  /** Engine profile ID used for this tab (references EngineProfile.id) */
  engineProfileId: string | null
  /** Short single-line preview of the last visible message (~80 chars), used
   *  as a tab-pill subtitle to help distinguish multiple Jarvis sessions. */
  lastMessagePreview: string | null
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'harness'
  content: string
  toolName?: string
  toolInput?: string
  toolId?: string
  toolStatus?: 'running' | 'completed' | 'error'
  /** True for messages originating from user bash command entry (! prefix) */
  userExecuted?: boolean
  /** True when the expand-tool-results setting auto-expanded this result */
  autoExpandResult?: boolean
  /** File or plan attachments associated with this message */
  attachments?: Attachment[]
  /**
   * Optional dedup key carried verbatim from
   * `engine_harness_message.metadata.dedupKey`. The renderer uses it to
   * suppress repeated emissions in the same engine-instance scrollback —
   * if a `role: 'harness'` message with this key already exists in the
   * key's message list, the new event is dropped instead of pushed.
   * Persists with the message so dedup survives app restart and rehydrate.
   * Other roles ignore this field; only harness messages opt in.
   * Convention: `<extensionName>:<messageKey>` (e.g. `ion-meta:welcome`).
   * See engine-event-slice.ts for the consumer logic and
   * docs/protocol/server-events.md for the well-known-keys table.
   */
  dedupKey?: string
  /**
   * Path to the plan file associated with a plan-created divider message.
   * Populated only on `role: 'system'` messages whose content starts with
   * `── Plan created`. The renderer uses it to make the plan slug clickable
   * (opens the plan preview, same as clicking a plan in the attachment drawer).
   * Client-only field — NOT part of the Go contract or wire protocol.
   */
  planFilePath?: string
  timestamp: number
  /**
   * Local UI state only -- NOT a wire protocol field, NOT persisted.
   * Set to true by engine_message_end so the next engine_text_delta
   * opens a fresh assistant message instead of appending to this one.
   */
  sealed?: boolean
}

export interface RunResult {
  totalCostUsd: number
  durationMs: number
  numTurns: number
  usage: UsageData
  sessionId: string
}

// ─── Run Options ───

export interface RunOptions {
  prompt: string
  projectPath: string
  /** Conversation ID to resume (loads existing conversation history) */
  sessionId?: string
  model?: string
  /** Extra directories to add (session-preserving) */
  addDirs?: string[]
  /** Extra context appended to the system prompt (additive, not replacement) */
  appendSystemPrompt?: string
  /** Origin of the prompt — 'remote' skips iOS forwarding (already echoed) */
  source?: 'desktop' | 'remote'
  /** Max output tokens per LLM turn */
  maxTokens?: number
  /** Extended thinking config */
  thinking?: { enabled: boolean; budgetTokens?: number }
  /** Extension entry points for engine tabs (resolved from engine profile) */
  extensions?: string[]
  /**
   * Tells the engine that this run is the "implement" half of a
   * plan-then-implement flow. The desktop sets this on the run dispatched
   * by the Implement button on the plan-approval card. The engine
   * responds by suppressing the EnterPlanMode sentinel tool injection so
   * the model cannot re-propose a plan-mode entry against the user's
   * already-approved intent.
   *
   * Replaces the prior mechanism, which was the desktop prepending a
   * "You are implementing a user-approved plan. Do not re-enter plan
   * mode..." preamble to the user prompt and the EnterPlanMode tool's
   * docstring telling the model to recognize those phrases. The boolean
   * is the mechanical equivalent and lives on the structured wire
   * contract instead of in prompt prose.
   */
  implementationPhase?: boolean
  /**
   * Harness-supplied description prose for the EnterPlanMode sentinel
   * tool that the engine injects during auto-mode runs. The desktop
   * supplies this from the ENTER_PLAN_MODE_DESCRIPTION constant in
   * prompt-pipeline.ts on every prompt that wants the full plan-mode
   * framing; the engine forwards it verbatim to the LLM as the tool's
   * description.
   *
   * Per ADR-004 (Move EnterPlanMode prose to harness): the policy
   * prose that tells the model WHEN to enter plan mode and WHAT the
   * rules are once enabled belongs in the harness, not the engine.
   * The engine ships only a one-line neutral fallback used when this
   * field is empty / omitted; third-party harnesses pick their own
   * (TUIs, domain-specific harnesses, etc.).
   *
   * Skipping this field on the "implement" half of a plan-then-
   * implement flow is harmless — the engine already suppresses
   * EnterPlanMode injection when implementationPhase=true, so any
   * description value would be unused.
   */
  enterPlanModeDescription?: string
  /**
   * Harness-supplied text for the per-turn sparse plan-mode reminder the
   * engine injects every planModeReminderInterval turns (default: every 5).
   * When non-empty, the engine uses this string verbatim instead of building
   * the reminder from the plan file path.
   *
   * Parallel override to enterPlanModeDescription: same additive optional
   * contract. Omit or leave empty to inherit the engine's default reminder.
   * The desktop ships its reference prose as PLAN_MODE_SPARSE_REMINDER in
   * prompt-pipeline.ts; third-party harnesses pick their own or omit.
   */
  planModeSparseReminder?: string
  /**
   * Pre-encoded image attachments for the user message. The engine forwards
   * each as a native multimodal content block. Desktop is responsible for
   * reading the file, base64-encoding the bytes, and dropping unreadable
   * entries before they reach the engine.
   */
  imageAttachments?: ImageAttachmentPayload[]
  /**
   * Persisted plan file path from tab state. When set, the engine uses this
   * path instead of allocating a fresh slug — restoring continuity after
   * desktop restart. The engine validates that the file exists on disk; if
   * the file is missing it falls back to allocating a new slug as before.
   *
   * Only sent when tab.planFilePath is non-null. Tabs that have never
   * entered plan mode omit this field and the engine's behavior is
   * unchanged.
   */
  planFilePath?: string
}

/** Pre-encoded image bytes that ride alongside a user prompt. */
export interface ImageAttachmentPayload {
  /** MIME type, e.g. "image/jpeg", "image/png", "image/webp", "image/gif". */
  mediaType: string
  /** Base64-encoded image bytes (no data URL prefix). */
  data: string
  /** Source path on disk; carried for logging only. */
  path?: string
}

// ─── Control Plane Types ───

export interface TabRegistryEntry {
  tabId: string
  conversationId: string | null
  status: TabStatus
  activeRequestId: string | null
  runPid: number | null
  createdAt: number
  lastActivityAt: number
  promptCount: number
}

export interface HealthReport {
  tabs: Array<{
    tabId: string
    status: TabStatus
    activeRequestId: string | null
    conversationId: string | null
    alive: boolean
    lastActivityAt: number
  }>
  queueDepth: number
}

export interface EnrichedError {
  message: string
  stderrTail: string[]
  stdoutTail?: string[]
  exitCode: number | null
  elapsedMs: number
  toolCallCount: number
  sawPermissionRequest?: boolean
  permissionDenials?: Array<{ tool_name: string; tool_use_id: string }>
}

// ─── Session History ───

export interface SessionMeta {
  sessionId: string
  slug: string | null
  firstMessage: string | null
  lastResponse: string | null
  firstTimestamp?: string
  lastTimestamp: string
  size: number
  customTitle: string | null
  /** Decoded real filesystem path (null if directory no longer exists) */
  projectPath: string | null
  /** Human-readable label (basename of path, or fallback from encoded name) */
  projectLabel: string | null
  /** Raw encoded directory name (for loading sessions from deleted dirs) */
  encodedDir: string | null
  /** All session IDs in this composite conversation chain (including self) */
  chainSessionIds?: string[]
  /** Number of sessions in the chain (1 = standalone) */
  chainLength?: number
}

/** Maps root session IDs to their continuation chains for composite conversation grouping */
export interface SessionChainIndex {
  /** root session ID -> ordered list of continuation session IDs */
  chains: Record<string, string[]>
  /** any continuation session ID -> its root session ID */
  reverse: Record<string, string>
}

export interface SessionLoadMessage {
  role: string
  content: string
  toolName?: string
  toolId?: string
  toolInput?: string
  userExecuted?: boolean
  attachments?: Attachment[]
  timestamp: number
  internal?: boolean
}

// ─── Terminal Multiplexing ───

export type TerminalInstanceKind = string  // 'user' | 'commit' | 'cli' | 'tool:<toolId>'

export interface TerminalInstance {
  id: string              // nanoid
  label: string           // "Shell", "Commit", "CLI", "Shell 2", tool name
  kind: TerminalInstanceKind
  readOnly: boolean
  cwd: string
}

// ─── Quick Tools ───

export interface QuickTool {
  id: string              // UUID
  name: string            // display label, e.g. "Merge Flow"
  icon: string            // Phosphor icon name, e.g. "GitMerge"
  command: string          // shell command with optional {cwd} and {branch} vars
  directories?: string[]   // scoped base dirs (empty = available in all tabs)
}

export interface TerminalPaneState {
  instances: TerminalInstance[]
  activeInstanceId: string | null
}

// ─── Git Types ───

export interface GitCommit {
  hash: string
  fullHash: string
  parents: string[]
  authorName: string
  authorDate: string
  subject: string
  refs: GitRef[]
}

export interface GitRef {
  name: string
  type: 'head' | 'remote' | 'tag'
  isCurrent: boolean
}

export interface GitCommitDetail {
  filesChanged: number
  insertions: number
  deletions: number
}

export interface GitCommitFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string
}

export interface GitGraphData {
  commits: GitCommit[]
  isGitRepo: boolean
  totalCount: number
}

export type GitConflictKind = 'UU' | 'AA' | 'DD' | 'AU' | 'UA' | 'DU' | 'UD'

export interface GitChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict'
  staged: boolean
  oldPath?: string
  conflictKind?: GitConflictKind
  isSubmodule?: boolean
}

export interface GitChangesData {
  files: GitChangedFile[]
  branch: string
  isGitRepo: boolean
  ahead: number
  behind: number
}

export interface GitBranchInfo {
  name: string
  isCurrent: boolean
  upstream: string | null
  isRemote: boolean
}

// ─── Worktree Types ───

export type GitOpsMode = 'manual' | 'worktree'
export type WorktreeCompletionStrategy = 'merge-ff' | 'merge' | 'pr'

export interface WorktreeInfo {
  /** Physical path on disk (~/.ion/worktrees/...) */
  worktreePath: string
  /** Auto-generated branch name (wt/<nanoid>) */
  branchName: string
  /** Branch the worktree was created from */
  sourceBranch: string
  /** Original repo root path */
  repoPath: string
}

export interface WorktreeStatus {
  hasUncommittedChanges: boolean
  hasUnpushedCommits: boolean
  isMerged: boolean
  aheadCount: number
  behindCount: number
}

// ─── Filesystem Types ───

export interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedMs: number
}

// ─── Engine-host filesystem (browsed via the engine, may be remote) ───

/** One entry in a list_directory response from the engine. */
export interface EngineDirEntry {
  name: string
  isDir: boolean
  isSymlink: boolean
  readable: boolean
}

/** Response of the engine's list_directory RPC. */
export interface EngineDirListing {
  path: string
  parent: string | null
  entries: EngineDirEntry[]
  truncated: boolean
}

/** Response of the engine's get_host_info RPC. */
export interface EngineHostInfo {
  home: string
  username: string
  hostname: string
  os: string
  pathSep: string
}

// ─── Remote Control Types ───

export interface RemoteSettings {
  remoteEnabled: boolean
  relayUrl: string
  relayApiKey: string
  lanServerPort: number
  pairedDevices: RemotePairedDevice[]
}

export interface RemotePairedDevice {
  id: string
  name: string
  pairedAt: string
  lastSeen: string | null
  channelId: string
}

export type RemoteTransportState = 'disconnected' | 'relay_only' | 'lan_preferred'
