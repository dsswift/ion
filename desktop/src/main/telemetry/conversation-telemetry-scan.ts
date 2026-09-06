/**
 * Conversation Telemetry scanner — one conversation file pair in, one metric
 * record out.
 *
 * ── Why this reads the tree and not the LLM file ────────────────────────────
 * `<id>.llm.jsonl` is the model's context, so a /clear truncates it to what
 * came after. `<id>.tree.jsonl` is the whole record: a clear is a boundary
 * entry, not a deletion. A retro that read the llm file would silently under-
 * report every conversation that has ever been cleared, which is the exact gap
 * this tool exists to close.
 *
 * ── Which entries count ─────────────────────────────────────────────────────
 * Chained entries are read along the active leaf path, so an abandoned branch
 * does not inflate a count and the numbers match the scrollback the client
 * renders. Detached entries — the ones the engine records with a null parent
 * and never chains, agent dispatches being the case that exists — are included
 * on top, because a path walk alone would report a conversation with two dozen
 * dispatches as having none.
 *
 * The prompt-counting rules mirror the engine's CountUserPrompts
 * (engine/internal/conversation/turn_count.go), which is the authority for what
 * a real prompt is. A tool return, an engine context injection, a skill
 * listing, and a display-only row all arrive as `role: "user"` and none of them
 * is a prompt.
 *
 * ── No message text leaves this file ────────────────────────────────────────
 * Every value returned is a count, a timestamp, an identifier, a path, or
 * money. Content is read to classify it and then dropped.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { log as _log, warn as _warn } from '../logger'
import type {
  ConversationTelemetry,
  TelemetryCompaction,
  TelemetryModelChange,
  TelemetryPlanMarker,
  TelemetrySlashCommand,
  TelemetryStop,
} from './conversation-telemetry-types'

const TAG = 'telemetry.scan'

/** A tree entry as persisted. Data is type-specific and read defensively. */
interface TreeEntry {
  id: string
  parentId: string | null
  type: string
  timestamp: number
  data?: Record<string, unknown>
}

interface TreeHeader {
  id?: string
  leafId?: string
  workingDirectory?: string
}

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  id?: string
  tool_use_id?: string
  is_error?: boolean
}

export interface ScanPaths {
  /** Directory holding the conversation files. Injectable so tests use a temp dir. */
  conversationsDir: string
}

/** Header fields the selector needs without paying for a full scan. */
export interface ConversationHeader {
  conversationId: string
  workingDirectory: string
}

/**
 * Read only the first line of a tree file.
 *
 * The selector calls this for every candidate that survives filename pruning,
 * so it must never read the body: a large conversation is megabytes and the
 * one fact needed here is on line one.
 */
export function readTreeHeader(conversationId: string, paths: ScanPaths): ConversationHeader | null {
  const file = join(paths.conversationsDir, `${conversationId}.tree.jsonl`)
  let firstLine: string
  try {
    // Reading the whole file and slicing is wasteful for a megabyte tree, so
    // take a bounded prefix: the header line is short and always first.
    const buffer = readFileSync(file)
    const newline = buffer.indexOf(0x0a)
    firstLine = buffer.subarray(0, newline === -1 ? buffer.length : newline).toString('utf-8')
  } catch (err) {
    _warn(TAG, 'tree header unreadable', { conversation_id: conversationId, error: String(err) })
    return null
  }
  try {
    const header = JSON.parse(firstLine) as TreeHeader
    return {
      conversationId: header.id ?? conversationId,
      workingDirectory: header.workingDirectory ?? '',
    }
  } catch (err) {
    _warn(TAG, 'tree header unparseable', { conversation_id: conversationId, error: String(err) })
    return null
  }
}

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

/**
 * The engine's real-prompt test, mirrored.
 *
 * Rules 1-3 (entry type, role, display-only) are checked by the caller, which
 * already has the entry. This covers rules 4 and 5: a prompt carries typed
 * text and no tool result, and is neither an engine context injection nor a
 * skill listing.
 */
function isRealPrompt(content: unknown): boolean {
  const blocks = blocksOf(content)
  if (blocks.length === 0) return false
  const first = blocks[0]?.type
  if (first === 'context_injection' || first === 'skill_content' || first === 'skill_listing') return false
  let hasText = false
  for (const block of blocks) {
    if (block.type === 'tool_result') return false
    if (block.type === 'text' && (block.text ?? '') !== '') hasText = true
  }
  return hasText
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1
}

function str(data: Record<string, unknown> | undefined, key: string): string {
  const value = data?.[key]
  return typeof value === 'string' ? value : ''
}

function num(data: Record<string, unknown> | undefined, key: string): number {
  const value = data?.[key]
  return typeof value === 'number' ? value : 0
}

/**
 * Entries to measure: the active leaf path, plus every entry the engine
 * recorded detached from it. Order is chronological so timeline fields
 * (stops before prompts, plan markers before implementation) read correctly.
 */
function selectEntries(entries: TreeEntry[], leafId: string): TreeEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const onPath = new Set<string>()
  let cursor: string | undefined = leafId
  // Bounded by the entry count: a malformed parent cycle must not spin here.
  while (cursor && !onPath.has(cursor)) {
    const entry = byId.get(cursor)
    if (!entry) break
    onPath.add(entry.id)
    cursor = entry.parentId ?? undefined
  }
  const selected = entries.filter((entry) => onPath.has(entry.id) || entry.parentId === null)
  return selected.sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Scan one conversation into its metric record.
 *
 * Returns null when the conversation has no tree file — a pre-minted id that
 * never saved is not a conversation, and reporting an empty record for it would
 * put phantoms in a retro.
 */
export function scanConversation(conversationId: string, paths: ScanPaths): ConversationTelemetry | null {
  const treePath = join(paths.conversationsDir, `${conversationId}.tree.jsonl`)
  const llmPath = join(paths.conversationsDir, `${conversationId}.llm.jsonl`)
  const memoryPath = join(paths.conversationsDir, `${conversationId}.memory.md`)
  if (!existsSync(treePath)) {
    _warn(TAG, 'no tree file for conversation', { conversation_id: conversationId, path: treePath })
    return null
  }

  let lines: string[]
  try {
    lines = readFileSync(treePath, 'utf-8').split('\n')
  } catch (err) {
    _warn(TAG, 'tree file unreadable', { conversation_id: conversationId, error: String(err) })
    return null
  }

  let header: TreeHeader = {}
  const entries: TreeEntry[] = []
  for (const line of lines) {
    if (line === '') continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A truncated tail line is normal after a hard kill mid-write. Skipping
      // it loses one entry; failing the scan would lose the conversation.
      continue
    }
    if (parsed.meta === true) {
      header = parsed as TreeHeader
      continue
    }
    entries.push(parsed as unknown as TreeEntry)
  }

  const record = emptyRecord(conversationId, treePath, llmPath, header)
  if (existsSync(memoryPath)) record.memoryPath = memoryPath
  const headerModel = applyLlmHeader(record, llmPath)
  measure(record, selectEntries(entries, header.leafId ?? ''))
  if (record.models.length === 0 && headerModel) record.models.push(headerModel)

  _log(TAG, 'conversation scanned', {
    conversation_id: conversationId,
    entries: entries.length,
    user_prompts: record.userPromptCount,
    tool_errors: Object.values(record.toolErrors).reduce((sum, n) => sum + n, 0),
    stops: record.stops.length,
    course_corrections: record.courseCorrections,
  })
  return record
}

function emptyRecord(
  conversationId: string,
  treePath: string,
  llmPath: string,
  header: TreeHeader,
): ConversationTelemetry {
  return {
    conversationId,
    workingDirectory: header.workingDirectory ?? '',
    treePath,
    llmPath,
    childIds: [],
    createdAt: 0,
    firstPromptAt: 0,
    lastActivityAt: 0,
    spanMs: 0,
    userPromptCount: 0,
    assistantTurnCount: 0,
    clearMarkers: [],
    compactions: [],
    toolCalls: {},
    toolErrors: {},
    stops: [],
    courseCorrections: 0,
    steerCount: 0,
    steerTimestamps: [],
    steerMessageLengths: [],
    slashCommands: [],
    planMarkers: [],
    models: [],
    modelChanges: [],
    modelUsage: [],
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    dispatches: { count: 0, byAgentName: {}, byStatus: {}, conversationIds: [] },
  }
}

/**
 * Money, tokens, and the parent link live in the llm header.
 *
 * Returns the header's model, which the caller uses only as a fallback. The
 * header names the model the conversation ran on MOST RECENTLY — the engine
 * advances it whenever a run serves a different one — so seeding `models` from
 * it would report the last model as the first. The turn record is the ordered
 * truth; this is what fills in for a conversation with no assistant turn.
 */
function applyLlmHeader(record: ConversationTelemetry, llmPath: string): string {
  if (!existsSync(llmPath)) return ''
  try {
    const buffer = readFileSync(llmPath)
    const newline = buffer.indexOf(0x0a)
    const line = buffer.subarray(0, newline === -1 ? buffer.length : newline).toString('utf-8')
    const header = JSON.parse(line) as Record<string, unknown>
    record.createdAt = num(header, 'createdAt')
    record.inputTokens = num(header, 'totalInputTokens')
    record.outputTokens = num(header, 'totalOutputTokens')
    record.costUsd = num(header, 'totalCost')
    const parentId = str(header, 'parentId')
    if (parentId) record.parentId = parentId
    return str(header, 'model')
  } catch (err) {
    _warn(TAG, 'llm header unreadable', { conversation_id: record.conversationId, error: String(err) })
    return ''
  }
}

/**
 * Record one assistant turn against the model that served it.
 *
 * Every assistant message entry persists its model and token usage, so the
 * per-model split is read rather than estimated. A turn with no model named
 * (a legacy file written before the field existed) is attributed to `unknown`
 * instead of being dropped, so the turn totals still reconcile.
 */
function creditModelTurn(record: ConversationTelemetry, model: string, at: number, usage: unknown): void {
  const name = model || 'unknown'
  let row = record.modelUsage.find((entry) => entry.model === name)
  if (!row) {
    row = { model: name, assistantTurns: 0, inputTokens: 0, outputTokens: 0, firstAt: at, lastAt: at }
    record.modelUsage.push(row)
    if (!record.models.includes(name)) record.models.push(name)
  }
  row.assistantTurns += 1
  row.lastAt = at
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>
    row.inputTokens += typeof u.input_tokens === 'number' ? u.input_tokens : 0
    row.outputTokens += typeof u.output_tokens === 'number' ? u.output_tokens : 0
  }
}

/**
 * Walk the selected entries once, in time order.
 *
 * One pass rather than one per metric, because the course-correction pairing
 * depends on order: a stop only becomes a redirect when a real prompt follows
 * it, and that is only knowable while walking forward through the timeline.
 */
function measure(record: ConversationTelemetry, entries: TreeEntry[]): void {
  // A tool result names its call by id, not by tool name, so the name has to be
  // carried forward from the tool_use block that opened it.
  const toolNameByUseId = new Map<string, string>()
  // A stop only becomes a course correction once the operator says something
  // next. Holding the pending stop here is what makes the count a recorded
  // pair rather than an inference about intent.
  let pendingOperatorStop = false

  for (const entry of entries) {
    if (entry.timestamp > record.lastActivityAt) record.lastActivityAt = entry.timestamp
    switch (entry.type) {
      case 'message':
        measureMessage(record, entry, toolNameByUseId, () => {
          if (pendingOperatorStop) {
            record.courseCorrections += 1
            pendingOperatorStop = false
          }
        })
        break
      case 'cleared':
        record.clearMarkers.push(entry.timestamp)
        break
      case 'compaction': {
        const compaction: TelemetryCompaction = { at: entry.timestamp }
        const strategy = str(entry.data, 'strategy')
        if (strategy) compaction.strategy = strategy
        const tokensBefore = num(entry.data, 'tokensBefore')
        if (tokensBefore) compaction.tokensBefore = tokensBefore
        record.compactions.push(compaction)
        break
      }
      case 'steer_marker':
        record.steerCount += 1
        record.steerTimestamps.push(entry.timestamp)
        record.steerMessageLengths.push(num(entry.data, 'messageLength'))
        break
      case 'plan_marker': {
        const marker: TelemetryPlanMarker = {
          at: entry.timestamp,
          operation: str(entry.data, 'operation'),
          path: str(entry.data, 'planFilePath'),
        }
        record.planMarkers.push(marker)
        break
      }
      case 'aborted': {
        const stop: TelemetryStop = {
          at: entry.timestamp,
          runId: str(entry.data, 'runId'),
          source: str(entry.data, 'source'),
        }
        const scope = str(entry.data, 'scope')
        if (scope) stop.scope = scope
        const signal = str(entry.data, 'signal')
        if (signal) stop.signal = signal
        record.stops.push(stop)
        // Only an operator stop can open a course correction. A hook or a
        // watchdog cancelling a run is not the operator redirecting.
        if (stop.source === 'user') pendingOperatorStop = true
        break
      }
      case 'model_change': {
        const change: TelemetryModelChange = { at: entry.timestamp, model: str(entry.data, 'model') }
        const previous = str(entry.data, 'previousModel')
        if (previous) change.previousModel = previous
        record.modelChanges.push(change)
        if (change.model && !record.models.includes(change.model)) record.models.push(change.model)
        break
      }
      case 'label': {
        // A label naming the conversation's own root is the closest thing the
        // store has to a title. Per-entry labels target other entries and are
        // not titles, so they are left alone.
        const label = entry.data?.label
        if (typeof label === 'string' && label && !record.title) record.title = label
        break
      }
      case 'agent_dispatch': {
        record.dispatches.count += 1
        bump(record.dispatches.byAgentName, str(entry.data, 'agentName') || 'unknown')
        bump(record.dispatches.byStatus, str(entry.data, 'status') || 'unknown')
        const childId = str(entry.data, 'conversationId')
        if (childId) record.dispatches.conversationIds.push(childId)
        break
      }
      default:
        break
    }
  }

  if (record.createdAt === 0 && entries.length > 0) record.createdAt = entries[0].timestamp
  const start = record.firstPromptAt || record.createdAt
  record.spanMs = record.lastActivityAt > start ? record.lastActivityAt - start : 0
}

function measureMessage(
  record: ConversationTelemetry,
  entry: TreeEntry,
  toolNameByUseId: Map<string, string>,
  onRealPrompt: () => void,
): void {
  const data = entry.data ?? {}
  const role = str(data, 'role')
  const blocks = blocksOf(data.content)

  if (role === 'assistant') {
    record.assistantTurnCount += 1
    creditModelTurn(record, str(data, 'model'), entry.timestamp, data.usage)
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const name = block.name ?? 'unknown'
      bump(record.toolCalls, name)
      if (block.id) toolNameByUseId.set(block.id, name)
    }
    return
  }
  if (role !== 'user') return

  // A failed tool result rides as a user message. Counting it by tool name is
  // what makes "flailing" measurable rather than impressionistic.
  for (const block of blocks) {
    if (block.type !== 'tool_result' || block.is_error !== true) continue
    bump(record.toolErrors, toolNameByUseId.get(block.tool_use_id ?? '') ?? 'unknown')
  }

  if (data.displayOnly === true) return
  if (!isRealPrompt(data.content)) return

  record.userPromptCount += 1
  if (record.firstPromptAt === 0) record.firstPromptAt = entry.timestamp
  const slashCommand = str(data, 'slashCommand')
  if (slashCommand) {
    const command: TelemetrySlashCommand = { at: entry.timestamp, name: slashCommand }
    const source = str(data, 'slashSource')
    if (source) command.source = source
    record.slashCommands.push(command)
  }
  onRealPrompt()
}
