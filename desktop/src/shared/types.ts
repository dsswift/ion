// ─── CLI Backend Stream Event Types ───

export interface InitEvent {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: Array<{ name: string; status: string }>
  model: string
  permissionMode: string
  agents: string[]
  skills: string[]
  plugins: string[]
  claude_code_version: string
  fast_mode_state: string
  uuid: string
}

export interface StreamEvent {
  type: 'stream_event'
  event: StreamSubEvent
  session_id: string
  parent_tool_use_id: string | null
  uuid: string
}

export type StreamSubEvent =
  | { type: 'message_start'; message: AssistantMessagePayload }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null }; usage: UsageData; context_management?: unknown }
  | { type: 'message_stop' }

export interface ContentBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }

export interface AssistantEvent {
  type: 'assistant'
  message: AssistantMessagePayload
  parent_tool_use_id: string | null
  session_id: string
  uuid: string
}

export interface AssistantMessagePayload {
  model: string
  id: string
  role: 'assistant'
  content: ContentBlock[]
  stop_reason: string | null
  usage: UsageData
}

export interface RateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: {
    status: string
    resetsAt: number
    rateLimitType: string
  }
  session_id: string
  uuid: string
}

export interface ResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  num_turns: number
  result: string
  total_cost_usd: number
  session_id: string
  usage: UsageData & {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  permission_denials: string[]
  uuid: string
}

export interface UsageData {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  service_tier?: string
}

export interface PermissionEvent {
  type: 'permission_request'
  tool: { name: string; description?: string; input?: Record<string, unknown> }
  question_id: string
  options: Array<{ id: string; label: string; kind?: string }>
  session_id: string
  uuid: string
}

// Union of all possible top-level events
export type ClaudeEvent = InitEvent | StreamEvent | AssistantEvent | RateLimitEvent | ResultEvent | PermissionEvent | UnknownEvent

export interface UnknownEvent {
  type: string
  [key: string]: unknown
}

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
  /** Latest input_tokens from API response (total context sent to model) */
  contextTokens: number | null
  /** Engine-computed context usage percentage (accounts for model-specific context window) */
  contextPercent: number | null
  /** Terminal-focused tab with no conversation */
  isTerminalOnly: boolean
  /** Whether this tab runs an engine session instead of CLI backend */
  isEngine: boolean
  /** Engine profile ID used for this tab (references EngineProfile.id) */
  engineProfileId: string | null
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
  timestamp: number
}

export interface RunResult {
  totalCostUsd: number
  durationMs: number
  numTurns: number
  usage: UsageData
  sessionId: string
}

// ─── Canonical Events (normalized from raw stream) ───

export type NormalizedEvent =
  | { type: 'session_init'; sessionId: string; tools: string[]; model: string; mcpServers: Array<{ name: string; status: string }>; skills: string[]; version: string; isWarmup?: boolean }
  | { type: 'text_chunk'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; toolName: string; toolId: string; index: number }
  | { type: 'tool_call_update'; toolId: string; partialInput: string }
  | { type: 'tool_call_complete'; index: number }
  | { type: 'tool_result'; toolId: string; content: string; isError: boolean }
  | { type: 'task_update'; message: AssistantMessagePayload }
  | { type: 'task_complete'; result: string; costUsd: number; durationMs: number; numTurns: number; usage: UsageData; sessionId: string; permissionDenials?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> }
  | { type: 'error'; message: string; isError: boolean; sessionId?: string; errorCode?: string; retryable?: boolean; retryAfterMs?: number; httpStatus?: number }
  | { type: 'session_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'rate_limit'; status: string; resetsAt: number; rateLimitType: string }
  | { type: 'usage'; usage: UsageData }
  | { type: 'permission_request'; questionId: string; toolName: string; toolDescription?: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'stream_reset' }
  | { type: 'compacting'; active: boolean }

// ─── Engine Types (native Ion extension runtime) ───

export interface EngineProfile {
  id: string
  name: string
  extensions: string[]
}

export interface EngineConfig {
  profileId: string
  extensions: string[]
  workingDirectory: string
  sessionId?: string
  maxTokens?: number
  thinking?: { enabled: boolean; budgetTokens?: number }
}

export interface EngineInstance {
  id: string        // crypto.randomUUID().slice(0,8)
  label: string     // "cos 1", "cos 2"
}

export interface EnginePaneState {
  instances: EngineInstance[]
  activeInstanceId: string | null
}

export interface AgentStateUpdate {
  name: string
  status: 'idle' | 'running' | 'done' | 'error'
  metadata?: Record<string, any>
}

/** Process registration handle for per-agent abort/steer */
export interface AgentHandle {
  pid?: number
  stdinWrite?: (message: string) => boolean
  parentAgent?: string
}

export interface StatusFields {
  label: string
  state: string
  sessionId?: string
  team?: string
  model: string
  contextPercent: number
  contextWindow: number
  totalCostUsd?: number
  /** Backend mode: 'api' (direct) or 'cli' (CC CLI proxy) */
  backend?: 'api' | 'cli'
  permissionDenials?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }>
}

export type EngineEvent =
  | { type: 'engine_agent_state'; agents: AgentStateUpdate[] }
  | { type: 'engine_status'; fields: StatusFields }
  | { type: 'engine_working_message'; message: string }
  | { type: 'engine_notify'; message: string; level: 'info' | 'warning' | 'error' }
  | { type: 'engine_dialog'; dialogId: string; method: 'select' | 'confirm' | 'input'; title: string; message?: string; options?: string[]; defaultValue?: string }
  | { type: 'engine_harness_message'; message: string; source?: string }
  | { type: 'engine_text_delta'; text: string }
  | { type: 'engine_message_end'; usage: { inputTokens: number; outputTokens: number; contextPercent: number; cost: number } }
  | { type: 'engine_tool_start'; toolName: string; toolId: string }
  | { type: 'engine_tool_end'; toolId: string; result?: string; isError?: boolean }
  | { type: 'engine_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'engine_error'; message: string; errorCode?: string; errorCategory?: string; retryable?: boolean; retryAfterMs?: number; httpStatus?: number }
  | { type: 'engine_permission_request'; questionId: string; permToolName: string; permToolDescription?: string; permToolInput?: Record<string, unknown>; permOptions: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'engine_plan_mode_changed'; planModeEnabled: boolean; planFilePath?: string }
  | { type: 'engine_stream_reset' }
  | { type: 'engine_compacting'; active: boolean }
  | { type: 'engine_extension_died'; extensionName: string; exitCode: number | null; signal: string | null }
  | { type: 'engine_extension_respawned'; extensionName: string; attemptNumber: number }
  | { type: 'engine_extension_dead_permanent'; extensionName: string; attemptNumber: number }

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
}

// ─── IPC Channel Names ───

export const IPC = {
  // Request-response (renderer → main)
  START: 'ion:start',
  CREATE_TAB: 'ion:create-tab',
  PROMPT: 'ion:prompt',
  CANCEL: 'ion:cancel',
  STOP_TAB: 'ion:stop-tab',
  RETRY: 'ion:retry',
  STATUS: 'ion:status',
  TAB_HEALTH: 'ion:tab-health',
  CLOSE_TAB: 'ion:close-tab',
  SELECT_DIRECTORY: 'ion:select-directory',
  SELECT_EXTENSION_FILES: 'ion:select-extension-files',
  OPEN_EXTERNAL: 'ion:open-external',
  OPEN_IN_VSCODE: 'ion:open-in-vscode',
  ATTACH_FILES: 'ion:attach-files',
  ATTACH_FILE_BY_PATH: 'ion:attach-file-by-path',
  TAKE_SCREENSHOT: 'ion:take-screenshot',
  TRANSCRIBE_AUDIO: 'ion:transcribe-audio',
  PASTE_IMAGE: 'ion:paste-image',
  GET_DIAGNOSTICS: 'ion:get-diagnostics',
  RESPOND_PERMISSION: 'ion:respond-permission',
  APPROVE_DENIED_TOOLS: 'ion:approve-denied-tools',
  INIT_SESSION: 'ion:init-session',
  RESET_TAB_SESSION: 'ion:reset-tab-session',
  ANIMATE_HEIGHT: 'ion:animate-height',
  LIST_SESSIONS: 'ion:list-sessions',
  LIST_ALL_SESSIONS: 'ion:list-all-sessions',
  LOAD_SESSION: 'ion:load-session',
  READ_PLAN: 'ion:read-plan',

  // One-way events (main → renderer)
  TEXT_CHUNK: 'ion:text-chunk',
  TOOL_CALL: 'ion:tool-call',
  TOOL_CALL_UPDATE: 'ion:tool-call-update',
  TOOL_CALL_COMPLETE: 'ion:tool-call-complete',
  TASK_UPDATE: 'ion:task-update',
  TASK_COMPLETE: 'ion:task-complete',
  SESSION_DEAD: 'ion:session-dead',
  SESSION_INIT: 'ion:session-init',
  ERROR: 'ion:error',
  RATE_LIMIT: 'ion:rate-limit',

  // Window management
  RESIZE_HEIGHT: 'ion:resize-height',
  SET_WINDOW_WIDTH: 'ion:set-window-width',
  HIDE_WINDOW: 'ion:hide-window',
  WINDOW_SHOWN: 'ion:window-shown',
  SET_IGNORE_MOUSE_EVENTS: 'ion:set-ignore-mouse-events',
  IS_VISIBLE: 'ion:is-visible',

  // Skill provisioning (main → renderer)
  SKILL_STATUS: 'ion:skill-status',

  // Theme
  GET_THEME: 'ion:get-theme',
  THEME_CHANGED: 'ion:theme-changed',

  // Command discovery
  DISCOVER_COMMANDS: 'ion:discover-commands',

  // Permission mode
  SET_PERMISSION_MODE: 'ion:set-permission-mode',

  // Settings persistence
  LOAD_SETTINGS: 'ion:load-settings',
  SAVE_SETTINGS: 'ion:save-settings',
  SHOW_SETTINGS: 'ion:show-settings',

  // Tab persistence
  LOAD_TABS: 'ion:load-tabs',
  SAVE_TABS: 'ion:save-tabs',

  // Session labels
  SAVE_SESSION_LABEL: 'ion:save-session-label',
  LOAD_SESSION_LABELS: 'ion:load-session-labels',
  GENERATE_TITLE: 'ion:generate-title',

  // Session chains (composite conversation grouping)
  LOAD_SESSION_CHAINS: 'ion:load-session-chains',
  SAVE_SESSION_CHAINS: 'ion:save-session-chains',

  // Conversation retrieval (agent child sessions)
  GET_CONVERSATION: 'ion:get-conversation',

  // Backend mode
  GET_BACKEND: 'ion:get-backend',
  SWITCH_BACKEND: 'ion:switch-backend',

  // Git operations
  GIT_GRAPH: 'ion:git-graph',
  GIT_CHANGES: 'ion:git-changes',
  GIT_IS_REPO: 'ion:git-is-repo',
  GIT_COMMIT: 'ion:git-commit',
  GIT_FETCH: 'ion:git-fetch',
  GIT_PULL: 'ion:git-pull',
  GIT_PUSH: 'ion:git-push',
  GIT_BRANCHES: 'ion:git-branches',
  GIT_CHECKOUT: 'ion:git-checkout',
  GIT_CREATE_BRANCH: 'ion:git-create-branch',
  GIT_DIFF: 'ion:git-diff',
  GIT_STAGE: 'ion:git-stage',
  GIT_UNSTAGE: 'ion:git-unstage',
  GIT_DISCARD: 'ion:git-discard',
  GIT_DELETE_BRANCH: 'ion:git-delete-branch',
  GIT_COMMIT_DETAIL: 'ion:git-commit-detail',
  GIT_COMMIT_FILES: 'ion:git-commit-files',
  GIT_COMMIT_FILE_DIFF: 'ion:git-commit-file-diff',
  GIT_IGNORED_FILES: 'ion:git-ignored-files',

  // Git worktree operations
  GIT_WORKTREE_ADD: 'ion:git-worktree-add',
  GIT_WORKTREE_REMOVE: 'ion:git-worktree-remove',
  GIT_WORKTREE_LIST: 'ion:git-worktree-list',
  GIT_WORKTREE_STATUS: 'ion:git-worktree-status',
  GIT_WORKTREE_MERGE: 'ion:git-worktree-merge',
  GIT_WORKTREE_PUSH: 'ion:git-worktree-push',
  GIT_WORKTREE_REBASE: 'ion:git-worktree-rebase',

  // Filesystem operations
  FS_READ_DIR: 'ion:fs-read-dir',
  FS_READ_FILE: 'ion:fs-read-file',
  FS_WRITE_FILE: 'ion:fs-write-file',
  FS_CREATE_DIR: 'ion:fs-create-dir',
  FS_CREATE_FILE: 'ion:fs-create-file',
  FS_RENAME: 'ion:fs-rename',
  FS_DELETE: 'ion:fs-delete',
  FS_SAVE_DIALOG: 'ion:fs-save-dialog',
  FS_REVEAL_IN_FINDER: 'ion:fs-reveal-in-finder',
  FS_OPEN_NATIVE: 'ion:fs-open-native',
  FS_WATCH_FILE: 'ion:fs-watch-file',
  FS_UNWATCH_FILE: 'ion:fs-unwatch-file',
  FS_FILE_CHANGED: 'ion:fs-file-changed',

  // Fonts
  LIST_FONTS: 'ion:list-fonts',

  // Terminal PTY
  TERMINAL_CREATE: 'ion:terminal-create',
  TERMINAL_DATA: 'ion:terminal-data',
  TERMINAL_RESIZE: 'ion:terminal-resize',
  TERMINAL_INCOMING: 'ion:terminal-incoming',
  TERMINAL_EXIT: 'ion:terminal-exit',
  TERMINAL_DESTROY: 'ion:terminal-destroy',

  // Bash command execution
  EXECUTE_BASH: 'ion:execute-bash',
  CANCEL_BASH: 'ion:cancel-bash',

  // Remote commands (main → renderer, for commands sent from iOS)
  REMOTE_USER_MESSAGE: 'ion:remote-user-message',
  REMOTE_BASH_COMMAND: 'ion:remote-bash-command',
  REMOTE_SET_PERMISSION_MODE: 'ion:remote-set-permission-mode',
  REMOTE_CLOSE_TAB: 'ion:remote-close-tab',
  REMOTE_RENAME_TAB: 'ion:remote-rename-tab',
  REMOTE_RENAME_TERMINAL_INSTANCE: 'ion:remote-rename-terminal-instance',
  // Remote send (renderer → main → iOS, for forwarding results to remote)
  REMOTE_SEND: 'ion:remote-send',
  REMOTE_SET_LAN_DISABLED: 'ion:remote-set-lan-disabled',

  // Remote control
  REMOTE_GET_STATE: 'ion:remote-get-state',
  REMOTE_START_PAIRING: 'ion:remote-start-pairing',
  REMOTE_CANCEL_PAIRING: 'ion:remote-cancel-pairing',
  REMOTE_REVOKE_DEVICE: 'ion:remote-revoke-device',
  REMOTE_STATE_CHANGED: 'ion:remote-state-changed',
  REMOTE_DISCOVER_RELAYS: 'ion:remote-discover-relays',
  REMOTE_STOP_DISCOVERY: 'ion:remote-stop-discovery',
  REMOTE_TEST_RELAY: 'ion:remote-test-relay',
  REMOTE_RELAYS_CHANGED: 'ion:remote-relays-changed',
  REMOTE_DEVICE_PAIRED: 'ion:remote-device-paired',
  REMOTE_DEVICE_REVOKED: 'ion:remote-device-revoked',
  REMOTE_GET_MESSAGES: 'ion:remote-get-messages',

  // Engine (native extension runtime)
  ENGINE_START: 'ion:engine-start',
  ENGINE_PROMPT: 'ion:engine-prompt',
  ENGINE_ABORT: 'ion:engine-abort',
  ENGINE_ABORT_AGENT: 'ion:engine-abort-agent',
  ENGINE_DIALOG_RESPONSE: 'ion:engine-dialog-response',
  ENGINE_COMMAND: 'ion:engine-command',
  ENGINE_STOP: 'ion:engine-stop',
  ENGINE_EVENT: 'ion:engine-event',

  // Legacy (kept for backward compat during migration)
  STREAM_EVENT: 'ion:stream-event',
  RUN_COMPLETE: 'ion:run-complete',
  RUN_ERROR: 'ion:run-error',
} as const

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

export interface GitChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  oldPath?: string
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
export type WorktreeCompletionStrategy = 'merge' | 'pr'

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
