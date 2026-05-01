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
