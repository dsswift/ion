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

/**
 * What one model actually did inside a conversation.
 *
 * The conversation header names one model and `costUsd` is a single number for
 * the whole file, so neither can answer "how much of this ran on Fable" once a
 * conversation switched models. Every assistant turn persists the model that
 * served it and its token usage, so the turn-level split is measured rather
 * than apportioned. Cost stays absent here on purpose: no per-turn price is
 * persisted, and splitting the total by tokens would invent a number.
 */
export interface TelemetryModelUsage {
  model: string
  assistantTurns: number
  inputTokens: number
  outputTokens: number
  firstAt: number
  lastAt: number
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
   *
   * Excludes machine-authored steers (a background dispatch completion, a
   * check-in) — see machineSteerCount. The engine persists a steer marker's
   * origin (SteerMarkerData.machineAuthored), so this is a real classification
   * read from the record, not a guess from message content.
   */
  steerCount: number
  steerTimestamps: number[]
  steerMessageLengths: number[]
  /**
   * Steers the engine injected on its own — a background dispatch completion
   * arriving mid-turn, a check-in — never counted in steerCount because they
   * carry no operator intent. Kept visible rather than dropped: a conversation
   * with heavy background-dispatch use should not read as having zero steer
   * activity at all.
   */
  machineSteerCount: number

  slashCommands: TelemetrySlashCommand[]
  planMarkers: TelemetryPlanMarker[]

  /** Every model that served a turn, in the order each was first seen. */
  models: string[]
  modelChanges: TelemetryModelChange[]
  /** Per-model turn and token split, ordered like `models`. */
  modelUsage: TelemetryModelUsage[]

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
  machineSteers: number
  toolCalls: number
  toolErrors: number
  dispatches: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /**
   * Every model that served a turn anywhere in scope, rolled up. This is what
   * answers "how much of this project ran on which model" — the per-model cost
   * is deliberately absent, because no per-turn price is persisted.
   */
  modelUsage: TelemetryModelUsage[]
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
