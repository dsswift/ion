/**
 * transcript-row — the one row shape a thin client renders, projected from the
 * server store's own `Message`s.
 *
 * The server store (`conversationPanes`) is the transcript. Studio renders its
 * rows directly; a thin client (iOS) receives them through this projection.
 * The projection only drops what is the owner's business (reducer state the
 * server already applied) and bounds what is too heavy to ship. It never
 * derives, renames, or reorders anything, so a thin client and Studio are
 * looking at the same rows.
 *
 * `TRANSCRIPT_FIELD_CLASS` is checked against `keyof Message`: a field added to
 * `Message` without deciding whether a thin client sees it fails the
 * typecheck, rather than silently never reaching the phone.
 */
import type { Attachment, Message } from '../types-session'
import type { BackgroundWorkInfo } from '../types-background-work'

/** Whether a `Message` field ships to thin clients or stays with the owner. */
export type TranscriptFieldClass = 'wire' | 'owner-only'

/**
 * Every `Message` field, classified. `owner-only` fields are reducer state the
 * server has already acted on:
 *  - `sealed` decides whether the next text chunk opens a new row. The server
 *    applied it; the thin client receives the resulting rows.
 *  - `dedupKey` decides whether a harness message is dropped or relocated. The
 *    server applied it; the result is already in the row list.
 */
export const TRANSCRIPT_FIELD_CLASS = {
  id: 'wire',
  role: 'wire',
  content: 'wire',
  toolName: 'wire',
  toolInput: 'wire',
  toolId: 'wire',
  toolStatus: 'wire',
  userExecuted: 'wire',
  attachments: 'wire',
  dedupKey: 'owner-only',
  planFilePath: 'wire',
  slashCommand: 'wire',
  slashArgs: 'wire',
  slashSource: 'wire',
  slashModelAlias: 'wire',
  slashModelEffective: 'wire',
  slashFrontmatter: 'wire',
  implementationPhase: 'wire',
  interceptLevel: 'wire',
  timestamp: 'wire',
  sealed: 'owner-only',
  steerPending: 'wire',
  steerFailed: 'wire',
  steerApplied: 'wire',
  injectionKind: 'wire',
  steerAppliedDividerId: 'wire',
  thinkingActive: 'wire',
  thinkingElapsedSeconds: 'wire',
  thinkingTotalTokens: 'wire',
  thinkingRedacted: 'wire',
  backgroundWork: 'wire',
  backgroundTaskId: 'wire',
  clientMsgId: 'wire',
} as const satisfies Record<keyof Message, TranscriptFieldClass>

/** An attachment as a thin client sees it: a reference, never inline bytes. */
export interface TranscriptAttachment {
  id: string
  type: 'image' | 'file' | 'plan'
  name: string
  path: string
  mimeType?: string
  size?: number
  contentHash?: string
}

/** One transcript row on the wire. Field meanings are `Message`'s. */
export interface TranscriptRow {
  id: string
  role: Message['role']
  content: string
  /**
   * True when `content` was cut to the wire cap. `contentBytes` is then the
   * UTF-8 size of the whole value, so a client can say how much it is not
   * showing. Absent on every row that was not cut.
   */
  contentTruncated?: true
  contentBytes?: number
  toolName?: string
  toolInput?: string
  toolId?: string
  toolStatus?: Message['toolStatus']
  userExecuted?: boolean
  attachments?: TranscriptAttachment[]
  planFilePath?: string
  slashCommand?: string
  slashArgs?: string
  slashSource?: string
  slashModelAlias?: string
  slashModelEffective?: string
  slashFrontmatter?: Record<string, unknown>
  implementationPhase?: boolean
  interceptLevel?: string
  timestamp: number
  steerPending?: boolean
  steerFailed?: boolean
  steerApplied?: boolean
  injectionKind?: string
  steerAppliedDividerId?: string
  thinkingActive?: boolean
  thinkingElapsedSeconds?: number
  thinkingTotalTokens?: number
  thinkingRedacted?: boolean
  backgroundWork?: BackgroundWorkInfo
  backgroundTaskId?: string
  clientMsgId?: string
}

/**
 * Characters of a tool row's `content` shipped to a thin client. Tool output
 * can be megabytes (a build log, a file dump); the phone shows the head and
 * says it was cut. Text a person or model wrote is never cut.
 */
export const TOOL_CONTENT_WIRE_CAP = 2048

const encoder = new TextEncoder()

/** UTF-8 byte length, the unit every wire budget is measured in. */
export function utf8Bytes(value: string): number {
  return encoder.encode(value).length
}

/** Cut at `cap` UTF-16 units without splitting a surrogate pair. */
function cutAt(value: string, cap: number): string {
  const end = value.charCodeAt(cap - 1) >= 0xd800 && value.charCodeAt(cap - 1) <= 0xdbff ? cap - 1 : cap
  return value.slice(0, end)
}

function projectAttachment(a: Attachment): TranscriptAttachment {
  // `dataUrl` is an inline base64 preview for the owner's own renderer. It is
  // deliberately not shipped: the wire carries paths, and a client fetches the
  // bytes it needs.
  const out: TranscriptAttachment = { id: a.id, type: a.type, name: a.name, path: a.path }
  if (a.type !== 'plan') {
    if (a.mimeType !== undefined) out.mimeType = a.mimeType
    if (a.size !== undefined) out.size = a.size
    if (a.contentHash !== undefined) out.contentHash = a.contentHash
  }
  return out
}

/** The plan file a `Write` tool row created, when it wrote one. */
export function planFileWrittenBy(message: Message): string | undefined {
  if (message.role !== 'tool' || message.toolName !== 'Write' || !message.toolInput) return undefined
  try {
    const input = JSON.parse(message.toolInput) as { file_path?: unknown }
    const fp = input.file_path
    // Separator-agnostic: a Windows path joins with backslashes.
    if (typeof fp === 'string' && /[/\\]\.ion[/\\]plans[/\\][^/\\]+\.md$/.test(fp)) return fp
  } catch {
    // silent-ok: tool input that is not JSON names no plan file.
  }
  return undefined
}

/** The plan path an ExitPlanMode row carries in its own tool input, if any. */
function planPathFromOwnInput(message: Message): string | undefined {
  if (!message.toolInput) return undefined
  try {
    const input = JSON.parse(message.toolInput) as { planFilePath?: unknown }
    return typeof input.planFilePath === 'string' && input.planFilePath.length > 0 ? input.planFilePath : undefined
  } catch {
    // silent-ok: unparseable input carries no path; the fallback applies.
    return undefined
  }
}

/**
 * Project one `Message` onto the wire.
 *
 * `planPathBefore` is the plan file most recently written by a row BEFORE this
 * one. It is used only when this row is an `ExitPlanMode` call whose own input
 * names no plan: that is the plan the model is asking to leave plan mode with.
 * Resolving from earlier rows (not the whole transcript) keeps a row's
 * projection independent of anything that arrives after it.
 */
export function projectTranscriptRow(message: Message, planPathBefore?: string): TranscriptRow {
  const row: TranscriptRow = {
    id: message.id,
    role: message.role,
    content: message.content ?? '',
    timestamp: message.timestamp ?? 0,
  }
  if (message.role === 'tool' && row.content.length > TOOL_CONTENT_WIRE_CAP) {
    row.contentBytes = utf8Bytes(row.content)
    row.content = cutAt(row.content, TOOL_CONTENT_WIRE_CAP)
    row.contentTruncated = true
  }
  for (const key of Object.keys(TRANSCRIPT_FIELD_CLASS) as Array<keyof Message>) {
    if (TRANSCRIPT_FIELD_CLASS[key] !== 'wire') continue
    if (key === 'id' || key === 'role' || key === 'content' || key === 'timestamp' || key === 'attachments') continue
    const value = message[key]
    if (value === undefined) continue
    // Nested values are copied, never shared. The store's reducer edits some
    // rows in place, and a projection that shared an object with the store
    // would change underneath the copy a publisher diffs against.
    ;(row as unknown as Record<string, unknown>)[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value
  }
  if (message.attachments && message.attachments.length > 0) {
    row.attachments = message.attachments.map(projectAttachment)
  }
  if (message.role === 'tool' && message.toolName === 'ExitPlanMode' && row.planFilePath === undefined) {
    const planPath = planPathFromOwnInput(message) ?? planPathBefore
    if (planPath !== undefined) row.planFilePath = planPath
  }
  return row
}

/**
 * Projects a whole row list, carrying the running plan path forward.
 *
 * Always projects every row. There is deliberately no cache keyed by the
 * source row object: the store's reducer updates some rows in place (a tool
 * row's streamed input and its result), so an unchanged object is not an
 * unchanged row, and a cache on identity silently stopped those updates from
 * ever reaching a client.
 */
export function projectTranscript(messages: readonly Message[]): TranscriptRow[] {
  let planPath: string | undefined
  const out: TranscriptRow[] = new Array(messages.length)
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    out[i] = projectTranscriptRow(message, planPath)
    planPath = planFileWrittenBy(message) ?? planPath
  }
  return out
}
