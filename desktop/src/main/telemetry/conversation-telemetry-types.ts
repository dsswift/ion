/**
 * Conversation Telemetry record shapes.
 *
 * Every field here is a count, a timestamp, an identifier, a path, or money.
 * None of them is message text. That is the defining property of this payload,
 * not an incidental one: an agent that wants prose reads the returned file
 * paths, which keeps the tool cheap enough to open a retro with and keeps a
 * casual caller from reaching for it as a transcript reader.
 */

/** One stop the engine recorded for a run. Mirrors the engine's aborted entry. */
export interface TelemetryStop {
  at: number
  runId: string
  /** 'user' for an operator stop; 'engine' for a cancel from inside the run. */
  source: string
  scope?: string
  signal?: string
}

export interface TelemetryCompaction {
  at: number
  strategy?: string
  tokensBefore?: number
}

export interface TelemetrySlashCommand {
  at: number
  name: string
  source?: string
}

export interface TelemetryPlanMarker {
  at: number
  operation: string
  path: string
}

export interface TelemetryModelChange {
  at: number
  model: string
  previousModel?: string
}

export interface TelemetryDispatches {
  count: number
  byAgentName: Record<string, number>
  byStatus: Record<string, number>
  /** Child conversation ids, so a retro can read a dispatch's own transcript. */
  conversationIds: string[]
}

export interface ConversationTelemetry {
  conversationId: string
  /** Present only when the tree carries a label entry naming the conversation. */
  title?: string
  workingDirectory: string
  treePath: string
  llmPath: string
  /** Present only when the conversation has a memory file on disk. */
  memoryPath?: string

  parentId?: string
  childIds: string[]

  createdAt: number
  firstPromptAt: number
  lastActivityAt: number
  spanMs: number

  /**
   * Real user prompts across the conversation's whole lifetime, including the
   * ones before a /clear. A clear is a context boundary, not a deletion, so
   * this number is routinely larger than what the live context window shows.
   */
  userPromptCount: number
  assistantTurnCount: number

  /** Timestamps of /clear checkpoints — where a live context window begins. */
  clearMarkers: number[]
  compactions: TelemetryCompaction[]

  /** Tool name → calls. */
  toolCalls: Record<string, number>
  /** Tool name → failed results. */
  toolErrors: Record<string, number>

  stops: TelemetryStop[]
  /**
   * Operator stops that were followed by a fresh user prompt — the operator's
   * actual redirect. Engine-side cancels are never counted here.
   */
  courseCorrections: number

  /**
   * Mid-turn operator additions. NOT course corrections: a steer is context the
   * operator forgot in the opening prompt, or a task appended while the agent
   * is already working. Read it as prompt completeness, never as agent error.
   */
  steerCount: number
  steerTimestamps: number[]
  steerMessageLengths: number[]

  slashCommands: TelemetrySlashCommand[]
  planMarkers: TelemetryPlanMarker[]

  models: string[]
  modelChanges: TelemetryModelChange[]

  inputTokens: number
  outputTokens: number
  costUsd: number

  dispatches: TelemetryDispatches
}

export interface TelemetryWorktree {
  worktreePath: string
  repoPath: string
  branchName: string
  sourceBranch: string | null
  title?: string
  createdAt: number
  landedAt?: number
}

export interface TelemetryTotals {
  /** Conversations actually measured in this payload. */
  conversations: number
  /** Conversations that matched the scope before any cap was applied. */
  matchedConversations: number
  /** True when a cap dropped matches; the dropped ones are the least recent. */
  truncated: boolean
  userPrompts: number
  assistantTurns: number
  courseCorrections: number
  steers: number
  toolCalls: number
  toolErrors: number
  dispatches: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  firstActivityAt: number
  lastActivityAt: number
  spanMs: number
}

export interface TelemetryPayload {
  scope: 'self' | 'worktree'
  worktree?: TelemetryWorktree
  totals: TelemetryTotals
  /** Oldest first, so a spec → implement → refine progression reads in order. */
  conversations: ConversationTelemetry[]
}
