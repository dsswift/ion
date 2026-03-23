// ─── Claude Code Stream Event Types (verified from v2.1.63) ───

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
  claudeSessionId: string | null
  status: TabStatus
  activeRequestId: string | null
  hasUnread: boolean
  currentActivity: string
  permissionQueue: PermissionRequest[]
  /** Fallback card when tools were denied and no interactive permission is available */
  permissionDenied: { tools: Array<{ toolName: string; toolUseId: string }> } | null
  attachments: FileAttachment[]
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
  /** Working directory for this tab's Claude sessions */
  workingDirectory: string
  /** Whether the user explicitly chose a directory (vs. using default home) */
  hasChosenDirectory: boolean
  /** Extra directories accessible via --add-dir (session-preserving) */
  additionalDirs: string[]
  /** Per-tab permission mode: 'ask' shows cards, 'auto' auto-approves, 'plan' uses CLI plan mode */
  permissionMode: 'ask' | 'auto' | 'plan'
  /** Pending bash command results to send as context with next prompt */
  bashResults: Array<{ command: string; stdout: string; stderr: string }>
  /** Whether a bash command is currently executing in this tab */
  bashExecuting: boolean
  /** ID of the currently executing bash command (for cancellation) */
  bashExecId: string | null
  /** Custom pill outline color (null = use theme default) */
  pillColor: string | null
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
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
  | { type: 'tool_call'; toolName: string; toolId: string; index: number }
  | { type: 'tool_call_update'; toolId: string; partialInput: string }
  | { type: 'tool_call_complete'; index: number }
  | { type: 'tool_result'; toolId: string; content: string; isError: boolean }
  | { type: 'task_update'; message: AssistantMessagePayload }
  | { type: 'task_complete'; result: string; costUsd: number; durationMs: number; numTurns: number; usage: UsageData; sessionId: string; permissionDenials?: Array<{ toolName: string; toolUseId: string }> }
  | { type: 'error'; message: string; isError: boolean; sessionId?: string }
  | { type: 'session_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'rate_limit'; status: string; resetsAt: number; rateLimitType: string }
  | { type: 'usage'; usage: UsageData }
  | { type: 'permission_request'; questionId: string; toolName: string; toolDescription?: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }

// ─── Run Options ───

export interface RunOptions {
  prompt: string
  projectPath: string
  sessionId?: string
  allowedTools?: string[]
  maxTurns?: number
  maxBudgetUsd?: number
  systemPrompt?: string
  model?: string
  /** Path to CODA-scoped settings file with hook config (passed via --settings) */
  hookSettingsPath?: string
  /** Extra directories to add via --add-dir (session-preserving) */
  addDirs?: string[]
  /** CLI permission mode override (e.g. 'plan') passed as --permission-mode */
  permissionModeCli?: string
}

// ─── Control Plane Types ───

export interface TabRegistryEntry {
  tabId: string
  claudeSessionId: string | null
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
    claudeSessionId: string | null
    alive: boolean
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
  lastTimestamp: string
  size: number
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

// ─── Marketplace / Plugin Types ───

export type PluginStatus = 'not_installed' | 'checking' | 'installing' | 'installed' | 'failed'

export interface CatalogPlugin {
  id: string              // unique: `${repo}/${skillPath}` e.g. 'anthropics/skills/skills/xlsx'
  name: string            // from SKILL.md or plugin.json
  description: string     // from SKILL.md or plugin.json
  version: string         // from plugin.json or '0.0.0'
  author: string          // from plugin.json or marketplace entry
  marketplace: string     // marketplace name from marketplace.json
  repo: string            // 'anthropics/skills'
  sourcePath: string      // path within repo, e.g. 'skills/xlsx'
  installName: string     // individual skill name for SKILL.md skills, bundle name for CLI plugins
  category: string        // 'Agent Skills' | 'Knowledge Work' | 'Financial Services'
  tags: string[]          // Semantic use-case tags derived from name/description (e.g. 'Design', 'Finance')
  isSkillMd: boolean      // true = individual SKILL.md (direct install), false = CLI plugin (bundle install)
}

// ─── IPC Channel Names ───

export const IPC = {
  // Request-response (renderer → main)
  START: 'coda:start',
  CREATE_TAB: 'coda:create-tab',
  PROMPT: 'coda:prompt',
  CANCEL: 'coda:cancel',
  STOP_TAB: 'coda:stop-tab',
  RETRY: 'coda:retry',
  STATUS: 'coda:status',
  TAB_HEALTH: 'coda:tab-health',
  CLOSE_TAB: 'coda:close-tab',
  SELECT_DIRECTORY: 'coda:select-directory',
  OPEN_EXTERNAL: 'coda:open-external',
  OPEN_IN_TERMINAL: 'coda:open-in-terminal',
  OPEN_IN_VSCODE: 'coda:open-in-vscode',
  ATTACH_FILES: 'coda:attach-files',
  TAKE_SCREENSHOT: 'coda:take-screenshot',
  TRANSCRIBE_AUDIO: 'coda:transcribe-audio',
  PASTE_IMAGE: 'coda:paste-image',
  GET_DIAGNOSTICS: 'coda:get-diagnostics',
  RESPOND_PERMISSION: 'coda:respond-permission',
  INIT_SESSION: 'coda:init-session',
  RESET_TAB_SESSION: 'coda:reset-tab-session',
  ANIMATE_HEIGHT: 'coda:animate-height',
  LIST_SESSIONS: 'coda:list-sessions',
  LOAD_SESSION: 'coda:load-session',
  READ_PLAN: 'coda:read-plan',

  // One-way events (main → renderer)
  TEXT_CHUNK: 'coda:text-chunk',
  TOOL_CALL: 'coda:tool-call',
  TOOL_CALL_UPDATE: 'coda:tool-call-update',
  TOOL_CALL_COMPLETE: 'coda:tool-call-complete',
  TASK_UPDATE: 'coda:task-update',
  TASK_COMPLETE: 'coda:task-complete',
  SESSION_DEAD: 'coda:session-dead',
  SESSION_INIT: 'coda:session-init',
  ERROR: 'coda:error',
  RATE_LIMIT: 'coda:rate-limit',

  // Window management
  RESIZE_HEIGHT: 'coda:resize-height',
  SET_WINDOW_WIDTH: 'coda:set-window-width',
  HIDE_WINDOW: 'coda:hide-window',
  WINDOW_SHOWN: 'coda:window-shown',
  SET_IGNORE_MOUSE_EVENTS: 'coda:set-ignore-mouse-events',
  IS_VISIBLE: 'coda:is-visible',

  // Skill provisioning (main → renderer)
  SKILL_STATUS: 'coda:skill-status',

  // Theme
  GET_THEME: 'coda:get-theme',
  THEME_CHANGED: 'coda:theme-changed',

  // Command discovery
  DISCOVER_COMMANDS: 'coda:discover-commands',

  // Marketplace
  MARKETPLACE_FETCH: 'coda:marketplace-fetch',
  MARKETPLACE_INSTALLED: 'coda:marketplace-installed',
  MARKETPLACE_INSTALL: 'coda:marketplace-install',
  MARKETPLACE_UNINSTALL: 'coda:marketplace-uninstall',

  // Permission mode
  SET_PERMISSION_MODE: 'coda:set-permission-mode',

  // Settings persistence
  LOAD_SETTINGS: 'coda:load-settings',
  SAVE_SETTINGS: 'coda:save-settings',
  SHOW_SETTINGS: 'coda:show-settings',

  // Tab persistence
  LOAD_TABS: 'coda:load-tabs',
  SAVE_TABS: 'coda:save-tabs',

  // Git operations
  GIT_GRAPH: 'coda:git-graph',
  GIT_CHANGES: 'coda:git-changes',
  GIT_IS_REPO: 'coda:git-is-repo',
  GIT_COMMIT: 'coda:git-commit',
  GIT_FETCH: 'coda:git-fetch',
  GIT_PULL: 'coda:git-pull',
  GIT_PUSH: 'coda:git-push',
  GIT_BRANCHES: 'coda:git-branches',
  GIT_CHECKOUT: 'coda:git-checkout',
  GIT_CREATE_BRANCH: 'coda:git-create-branch',
  GIT_DIFF: 'coda:git-diff',
  GIT_STAGE: 'coda:git-stage',
  GIT_UNSTAGE: 'coda:git-unstage',
  GIT_DISCARD: 'coda:git-discard',
  GIT_DELETE_BRANCH: 'coda:git-delete-branch',

  // Filesystem operations
  FS_READ_DIR: 'coda:fs-read-dir',
  FS_READ_FILE: 'coda:fs-read-file',
  FS_WRITE_FILE: 'coda:fs-write-file',
  FS_CREATE_DIR: 'coda:fs-create-dir',
  FS_CREATE_FILE: 'coda:fs-create-file',
  FS_RENAME: 'coda:fs-rename',
  FS_DELETE: 'coda:fs-delete',
  FS_SAVE_DIALOG: 'coda:fs-save-dialog',
  FS_REVEAL_IN_FINDER: 'coda:fs-reveal-in-finder',
  FS_OPEN_NATIVE: 'coda:fs-open-native',

  // Fonts
  LIST_FONTS: 'coda:list-fonts',

  // Terminal PTY
  TERMINAL_CREATE: 'coda:terminal-create',
  TERMINAL_DATA: 'coda:terminal-data',
  TERMINAL_RESIZE: 'coda:terminal-resize',
  TERMINAL_INCOMING: 'coda:terminal-incoming',
  TERMINAL_EXIT: 'coda:terminal-exit',
  TERMINAL_DESTROY: 'coda:terminal-destroy',

  // Bash command execution
  EXECUTE_BASH: 'coda:execute-bash',
  CANCEL_BASH: 'coda:cancel-bash',

  // Legacy (kept for backward compat during migration)
  STREAM_EVENT: 'coda:stream-event',
  RUN_COMPLETE: 'coda:run-complete',
  RUN_ERROR: 'coda:run-error',
} as const

// ─── Persisted Tab State ───

export interface PersistedTab {
  claudeSessionId: string | null
  title: string
  customTitle: string | null
  workingDirectory: string
  hasChosenDirectory: boolean
  additionalDirs: string[]
  permissionMode: 'ask' | 'auto' | 'plan'
  bashResults?: Array<{ command: string; stdout: string; stderr: string }>
  pillColor?: string | null
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
  /** Indices into tabs array for tabs that had the file editor open */
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
}

export interface GitBranchInfo {
  name: string
  isCurrent: boolean
  upstream: string | null
  isRemote: boolean
}

// ─── Filesystem Types ───

export interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedMs: number
}
