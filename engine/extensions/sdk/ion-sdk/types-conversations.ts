// Ion Extension SDK -- conversation record types.

/** An image attached to a {@link ConversationMessage}. */
export interface ConversationMessageAttachment {
  id: string
  /** Attachment kind, e.g. `'image'`. */
  type: string
  name: string
  /** Absolute path of the stored file. */
  path: string
  mimeType?: string
  contentHash?: string
}

/** One background task named by a {@link ConversationBackgroundWork}. */
export interface ConversationBackgroundWorkItem {
  id: string
  source: string
  label?: string
  status: string
  exitCode: number
  elapsedMs?: number
  outputPath?: string
}

/** Marks a message as the delivery of a background-work result. */
export interface ConversationBackgroundWork {
  kind: string
  deliveryMode: string
  items: ConversationBackgroundWorkItem[]
  remainingTaskIds?: string[]
}

/**
 * One row of a conversation record, as returned by
 * `ctx.conversations.read`. A user or assistant turn, a tool call, or a
 * marker the engine recorded (compaction, plan, steer).
 */
export interface ConversationMessage {
  /** Stable row id: the persisted entry id, or `<entryId>:<n>` for later rows of one entry. */
  id?: string
  /** `'user'`, `'assistant'`, `'tool'`, or `'system'`. */
  role: string
  content: string
  toolName?: string
  toolId?: string
  toolInput?: string
  /** When the row was recorded, in Unix milliseconds. */
  timestamp: number
  internal?: boolean
  /** Set on a tool row whose result was an error. */
  isError?: boolean
  /** The background task or dispatch that produced a tool row. */
  backgroundTaskId?: string
  /** Slash-command invocation fields, set when a user turn came from one. */
  slashCommand?: string
  slashArgs?: string
  slashSource?: string
  slashModelAlias?: string
  slashModelEffective?: string
  slashFrontmatter?: Record<string, unknown>
  /** Set when the user turn began the implementation half of a plan-then-implement flow. */
  implementationPhase?: boolean
  /** Marker family for a `'system'` row: `'compaction'`, `'plan'`, or `'steer'`. */
  markerKind?: string
  markerMessagesBefore?: number
  markerMessagesAfter?: number
  markerClearedBlocks?: number
  markerStrategy?: string
  markerMicroOnly?: boolean
  markerSummary?: string
  markerTrigger?: string
  markerPreTokens?: number
  markerPlanOperation?: string
  markerPlanFilePath?: string
  markerPlanSlug?: string
  markerMessageLength?: number
  markerMachineAuthored?: boolean
  backgroundWork?: ConversationBackgroundWork
  /** Classifies an engine-injected user turn, e.g. `'agent_completion'`. Empty for an ordinary turn. */
  injectionKind?: string
  /** Set when the turn was written by a machine rather than a person. */
  machineAuthored?: boolean
  attachments?: ConversationMessageAttachment[]
}

/** Paging for `ctx.conversations.read`. */
export interface ReadConversationOpts {
  /** Zero-based index of the first message to return. Defaults to 0. */
  offset?: number
  /** Maximum messages to return. Omitted or 0 returns every message from `offset` onward. */
  limit?: number
}

/** One page of a conversation record. */
export interface ConversationRecord {
  /** The page, in record order. */
  messages: ConversationMessage[]
  /** The record's full message count, independent of the page. */
  total: number
  /** Whether messages remain past this page. */
  hasMore: boolean
}
