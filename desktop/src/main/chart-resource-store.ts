/**
 * Chart resource store — the Desktop-owned CURRENT state of every named chart.
 *
 * ── Two records, one truth each ─────────────────────────────────────────────
 * A Chart Output has two durable homes, and the split is deliberate:
 *
 *   1. REVISION HISTORY lives in conversation history. Every `RenderChart`
 *      call is a tool row whose INPUT the engine already persists and replays
 *      (`list_flatten.go` → `SessionMessage.ToolInput`). Those rows are
 *      immutable and branch-scoped: a rewind hides the revisions that came
 *      after it, exactly like every other turn.
 *   2. CURRENT STATE lives here, as one conversation-scoped resource per
 *      chart. It answers "which revision is current, and where is it?" so the
 *      attachments panel can list a chart once and jump straight to its newest
 *      card without walking the transcript.
 *
 * This store is therefore a REBUILDABLE INDEX, never a second revision
 * database. It holds only the latest spec plus navigation metadata, and
 * `rebuildFromHistory` re-derives it from the tool rows visible on the active
 * branch. That is what makes rewind and fork correct: an abandoned future
 * revision cannot stay "current", because the rebuild never sees it.
 *
 * ── Why the engine is not involved ──────────────────────────────────────────
 * The engine's resource broker stores nothing — producers own persistence
 * (docs/architecture/resource-subsystem.md). Charts are a Desktop product
 * surface, so the Desktop persists them and publishes create/update deltas
 * through the existing generic `resource_publish` command. No engine change,
 * no new event type.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  type ChartRequest,
  type ChartSpec,
} from '../shared/chart-schema'
import { parseChartToolInput } from '../shared/chart-parse'
import { parseChartResultId } from '../shared/chart-result'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { log as _log, warn as _warn, error as _error } from './logger'

const TAG = 'chart-store'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error(TAG, msg, fields) }

/** The resource kind charts publish under. */
export const CHART_RESOURCE_KIND = 'chart'

/**
 * The JSON body of a chart resource.
 *
 * `toolMessageId` is the anchor the attachments panel jumps to: the id of the
 * tool row that produced the current revision. It is the bridge between the
 * mutable index and the immutable history.
 */
export interface ChartResourceContent {
  chartId: string
  title: string
  spec: ChartSpec
  /** 1-based; increments on every accepted update. */
  revision: number
  /** Tool-row id of the current revision, used for transcript navigation. */
  toolMessageId: string
  createdAt: string
  updatedAt: string
}

/** A persisted chart record with its conversation scope. */
export interface ChartRecord extends ChartResourceContent {
  conversationId: string
}

export interface ChartCommitContext {
  conversationId: string
  /** Tool-call id of the invocation being committed. */
  toolCallId: string
  /** Wall clock, injected so tests are deterministic. */
  now?: () => Date
}

export interface ChartCommitSuccess {
  ok: true
  record: ChartRecord
  /** Which resource op the caller should publish. */
  op: 'create' | 'update'
}

export interface ChartCommitFailure {
  ok: false
  message: string
}

export type ChartCommitResult = ChartCommitSuccess | ChartCommitFailure

function resourcesRoot(): string {
  return join(homedir(), '.ion', 'resources')
}

function conversationDir(conversationId: string): string {
  return join(resourcesRoot(), conversationId)
}

/**
 * On-disk filename for a chart resource.
 *
 * The `chart-` prefix matches the existing `briefing-...json` convention in
 * the resource directory, so the generic cold-loader picks charts up with no
 * special-casing.
 */
function chartFilePath(conversationId: string, chartId: string): string {
  return join(conversationDir(conversationId), `chart-${chartId}.json`)
}

/**
 * Derive a stable chart id from the tool-call id that created it.
 *
 * The tool-call id is already unique per conversation and already durable in
 * history, so reusing it means the identity needs no separate counter, no
 * random source, and no reconciliation after a restart. Non-alphanumerics are
 * folded out because the id becomes a filename.
 */
export function chartIdFromToolCallId(toolCallId: string): string {
  const cleaned = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-48)
  return cleaned.length > 0 ? cleaned : `c${Date.now().toString(36)}`
}

/** Normalized comparison form for a title's uniqueness check. */
function titleKey(title: string): string {
  return title.trim().toLowerCase()
}

/**
 * Read every chart record for a conversation.
 *
 * Corrupt or unparseable files are skipped with a warning rather than failing
 * the whole read: one bad file must not hide every other chart in the
 * conversation. Each body is re-validated through the shared parser, so a
 * record written by a future schema version is rejected here instead of
 * reaching the renderer as a half-understood chart.
 */
/**
 * Every conversation id that has persisted charts on disk.
 *
 * The resources directory is itself the index: one directory per conversation,
 * created only when that conversation persisted something. Enumerating it
 * needs no tabs file, no session, and no engine — which is what lets the
 * catalog be hydrated before the renderer's first read.
 */
export function conversationsWithCharts(): string[] {
  const root = resourcesRoot()
  if (!existsSync(root)) return []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (err) {
    warn('resources root unreadable', { error: String(err) })
    return []
  }
  return names.filter((name) => {
    const dir = join(root, name)
    try {
      return readdirSync(dir).some((f) => f.startsWith('chart-') && f.endsWith('.json'))
    } catch {
      // A non-directory entry, or one removed mid-scan. Not a chart source.
      return false
    }
  })
}

export function loadChartRecords(conversationId: string): ChartRecord[] {
  const dir = conversationDir(conversationId)
  if (!conversationId || !existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('chart-') && name.endsWith('.json'))
  } catch (err) {
    warn('chart directory unreadable', { conversation_id: conversationId, error: String(err) })
    return []
  }

  const records: ChartRecord[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
      const record = parseChartRecord(raw, conversationId)
      if (!record) {
        warn('chart record rejected', { conversation_id: conversationId, file: name })
        continue
      }
      records.push(record)
    } catch (err) {
      warn('chart record unreadable', { conversation_id: conversationId, file: name, error: String(err) })
    }
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  log('chart records loaded', { conversation_id: conversationId, count: records.length })
  return records
}

/**
 * Validate a persisted record. Returns null when the body is not a chart this
 * build can render — the same strictness the tool boundary applies, so the two
 * can never disagree about which specs are renderable.
 */
export function parseChartRecord(raw: unknown, conversationId: string): ChartRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const body = raw as Record<string, unknown>
  const { chartId, title, revision, toolMessageId, createdAt, updatedAt, spec } = body
  if (typeof chartId !== 'string' || chartId.length === 0) return null
  if (typeof title !== 'string' || title.length === 0) return null
  if (typeof toolMessageId !== 'string') return null
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return null

  const parsed = parseChartToolInput(spec)
  if (!parsed.ok) return null

  return {
    conversationId,
    chartId,
    title,
    spec: parsed.request.spec,
    revision,
    toolMessageId,
    createdAt,
    updatedAt,
  }
}

/**
 * Commit a validated chart request to disk.
 *
 * Ordering matters and is the reason this returns the op rather than
 * publishing itself: the caller publishes the resource delta only AFTER this
 * resolves, so a subscriber can never be told about a chart that failed to
 * persist. A restart then agrees with what every client was shown.
 */
export function commitChartRequest(
  request: ChartRequest,
  ctx: ChartCommitContext,
): ChartCommitResult {
  const { conversationId, toolCallId } = ctx
  if (!conversationId) {
    error('chart commit refused: no conversation', { tool_call_id: toolCallId })
    return { ok: false, message: 'This conversation has no durable id yet, so a chart cannot be saved. Send a prompt first, then try again.' }
  }

  const existing = loadChartRecords(conversationId)
  const nowIso = (ctx.now ?? (() => new Date()))().toISOString()

  if (request.operation === 'update') {
    const target = existing.find((record) => record.chartId === request.chartId)
    if (!target) {
      const known = existing.map((record) => `${record.chartId} ("${record.title}")`).join(', ')
      warn('chart update refused: unknown id', { conversation_id: conversationId, chart_id: request.chartId })
      return {
        ok: false,
        message: existing.length === 0
          ? `No chart with id "${request.chartId}" exists in this conversation. Omit operation to create a new chart.`
          : `No chart with id "${request.chartId}" exists in this conversation. Known charts: ${known}.`,
      }
    }
    // Both id and title must match. The id alone would let a hallucinated id
    // silently overwrite an unrelated chart; requiring the title turns that
    // mistake into a refusal the model can read and correct.
    if (titleKey(target.title) !== titleKey(request.expectedTitle)) {
      warn('chart update refused: title mismatch', {
        conversation_id: conversationId, chart_id: request.chartId,
      })
      return {
        ok: false,
        message: `Chart "${request.chartId}" is currently titled "${target.title}", not "${request.expectedTitle}". Pass the current title as expectedTitle to confirm you are updating this chart.`,
      }
    }
    const titleCollision = existing.find(
      (record) => record.chartId !== target.chartId && titleKey(record.title) === titleKey(request.spec.title),
    )
    if (titleCollision) {
      return {
        ok: false,
        message: `Another chart in this conversation is already titled "${request.spec.title}". Chart titles must be unique so they can be named unambiguously.`,
      }
    }

    const record: ChartRecord = {
      conversationId,
      chartId: target.chartId,
      title: request.spec.title,
      spec: request.spec,
      revision: target.revision + 1,
      toolMessageId: toolCallId,
      createdAt: target.createdAt,
      updatedAt: nowIso,
    }
    const written = writeChartRecord(record)
    if (!written.ok) return written
    log('chart updated', {
      conversation_id: conversationId, chart_id: record.chartId,
      revision: record.revision, kind: record.spec.kind,
      datasets: record.spec.datasets.length, points: record.spec.labels.length,
    })
    return { ok: true, record, op: 'update' }
  }

  const collision = existing.find((record) => titleKey(record.title) === titleKey(request.spec.title))
  if (collision) {
    warn('chart create refused: duplicate title', {
      conversation_id: conversationId, chart_id: collision.chartId,
    })
    return {
      ok: false,
      message: `A chart titled "${collision.title}" already exists in this conversation (id ${collision.chartId}). Update it with operation: "update", chartId: "${collision.chartId}", expectedTitle: "${collision.title}", or choose a different title for a new chart.`,
    }
  }

  const chartId = chartIdFromToolCallId(toolCallId)
  if (existing.some((record) => record.chartId === chartId)) {
    error('chart create refused: id collision', { conversation_id: conversationId, chart_id: chartId })
    return { ok: false, message: 'A chart with this generated id already exists. Retry the call.' }
  }

  const record: ChartRecord = {
    conversationId,
    chartId,
    title: request.spec.title,
    spec: request.spec,
    revision: 1,
    toolMessageId: toolCallId,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  const written = writeChartRecord(record)
  if (!written.ok) return written
  log('chart created', {
    conversation_id: conversationId, chart_id: record.chartId,
    kind: record.spec.kind, datasets: record.spec.datasets.length,
    points: record.spec.labels.length,
  })
  return { ok: true, record, op: 'create' }
}

function writeChartRecord(record: ChartRecord): { ok: true } | ChartCommitFailure {
  const dir = conversationDir(record.conversationId)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    error('chart directory create failed', { conversation_id: record.conversationId, error: String(err) })
    return { ok: false, message: 'Could not create the conversation resource directory, so the chart was not saved.' }
  }
  const body: ChartResourceContent = {
    chartId: record.chartId,
    title: record.title,
    spec: record.spec,
    revision: record.revision,
    toolMessageId: record.toolMessageId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  try {
    atomicWriteFileSync(chartFilePath(record.conversationId, record.chartId), JSON.stringify(body, null, 2), 0o644)
  } catch (err) {
    error('chart write failed', {
      conversation_id: record.conversationId, chart_id: record.chartId, error: String(err),
    })
    return { ok: false, message: 'Could not write the chart to disk, so it was not saved.' }
  }
  return { ok: true }
}

/** The resource item shape the broker publishes for a chart record. */
export function chartResourceItem(record: ChartRecord): {
  id: string
  kind: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  conversationId: string
  metadata: Record<string, unknown>
} {
  const content: ChartResourceContent = {
    chartId: record.chartId,
    title: record.title,
    spec: record.spec,
    revision: record.revision,
    toolMessageId: record.toolMessageId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  return {
    id: record.chartId,
    kind: CHART_RESOURCE_KIND,
    title: record.title,
    content: JSON.stringify(content),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    conversationId: record.conversationId,
    // Metadata duplicates the navigation fields so a metadata-only consumer
    // (the iOS snapshot manifest) can render and route a chart row without
    // parsing the full spec out of `content`.
    metadata: {
      chartRevision: record.revision,
      chartToolMessageId: record.toolMessageId,
      chartKind: record.spec.kind,
      chartSeriesCount: record.spec.datasets.length,
      chartPointCount: record.spec.labels.length,
    },
  }
}

/** One `RenderChart` tool row as seen on the active conversation branch. */
export interface ChartHistoryRow {
  /** Tool-row id — the transcript anchor. */
  toolMessageId: string
  /** Raw persisted `toolInput` JSON. */
  toolInput: string
  /**
   * The row's committed tool RESULT text.
   *
   * This is the IDENTITY channel, and it is the reason a rebuild cannot key on
   * `toolMessageId`. A chart id is minted from the tool-GATE request id
   * (`tool-gate-<nanos>-<seq>`); a transcript row is keyed by the engine's
   * tool-USE id (`toolu_…` / `call_…`). Those id spaces never intersect, so
   * deriving identity from the row id rebuilds a DIFFERENT chart than the one
   * the tool committed — every update would orphan and every create would mint
   * a duplicate. `chart-result.ts` owns both halves of the format.
   */
  resultText?: string
  /** Row order in the branch; later wins. */
  index: number
}

/** What a rebuild did to one chart record, for the caller's publish step. */
export interface ChartRebuildOutcome {
  records: ChartRecord[]
  /** Charts the branch produced that the index did not hold before. */
  created: ChartRecord[]
  /** Charts whose current revision, title, or spec moved. */
  updated: ChartRecord[]
  /** Charts the rebuild left byte-identical; nothing to publish. */
  retained: ChartRecord[]
  /** Chart ids whose files were deleted because the branch lost them. */
  removed: string[]
}

/**
 * Re-derive current chart state from the tool rows visible on a branch.
 *
 * This is what makes rewind, fork, and history replacement correct. The index
 * is discarded and rebuilt from what the branch can actually see, so a
 * revision that only exists on an abandoned branch can never remain current.
 * Records with no surviving revision are deleted, because a chart the branch
 * never produced must not linger in the attachments panel.
 *
 * The returned outcome partitions the result so the caller publishes exactly
 * the deltas that changed: a retained record must NOT be republished, or every
 * reconciliation would fan a no-op create to every subscriber.
 */
export function rebuildFromHistory(
  conversationId: string,
  rows: ChartHistoryRow[],
): ChartRebuildOutcome {
  const empty: ChartRebuildOutcome = {
    records: [], created: [], updated: [], retained: [], removed: [],
  }
  if (!conversationId) return empty

  const ordered = [...rows].sort((a, b) => a.index - b.index)
  const byChartId = new Map<string, ChartRecord>()
  const existing = new Map(loadChartRecords(conversationId).map((record) => [record.chartId, record]))

  for (const row of ordered) {
    let raw: unknown
    try {
      raw = JSON.parse(row.toolInput)
    } catch {
      // A partially-streamed tool input is expected mid-turn; it is not a
      // revision yet and simply has no place in the rebuild.
      continue
    }
    const parsed = parseChartToolInput(raw)
    if (!parsed.ok) continue

    // Identity comes from the row's own committed RESULT for BOTH operations.
    // A row with no parseable chart id never completed successfully (a refusal,
    // or a row still streaming), so it contributes nothing rather than minting
    // an id the tool never committed.
    const chartId = parseChartResultId(row.resultText)
    if (!chartId) continue

    const request = parsed.request
    if (request.operation === 'update') {
      const target = byChartId.get(chartId)
      if (!target) continue
      byChartId.set(chartId, {
        ...target,
        title: request.spec.title,
        spec: request.spec,
        revision: target.revision + 1,
        toolMessageId: row.toolMessageId,
        updatedAt: existing.get(chartId)?.updatedAt ?? target.updatedAt,
      })
      continue
    }

    const prior = existing.get(chartId)
    byChartId.set(chartId, {
      conversationId,
      chartId,
      title: request.spec.title,
      spec: request.spec,
      revision: 1,
      toolMessageId: row.toolMessageId,
      createdAt: prior?.createdAt ?? new Date().toISOString(),
      updatedAt: prior?.updatedAt ?? new Date().toISOString(),
    })
  }

  const removed: string[] = []
  for (const chartId of existing.keys()) {
    if (byChartId.has(chartId)) continue
    removed.push(chartId)
    try {
      unlinkSync(chartFilePath(conversationId, chartId))
    } catch (err) {
      warn('chart record delete failed', { conversation_id: conversationId, chart_id: chartId, error: String(err) })
    }
  }

  const records = [...byChartId.values()]
  const created: ChartRecord[] = []
  const updated: ChartRecord[] = []
  const retained: ChartRecord[] = []
  for (const record of records) {
    const prior = existing.get(record.chartId)
    const changed = !prior
      || prior.revision !== record.revision
      || prior.toolMessageId !== record.toolMessageId
      || prior.title !== record.title
      || JSON.stringify(prior.spec) !== JSON.stringify(record.spec)
    if (!changed) {
      retained.push(record)
      continue
    }
    const written = writeChartRecord(record)
    if (!written.ok) {
      error('chart rebuild write failed', { conversation_id: conversationId, chart_id: record.chartId })
      // A record that did not persist must not be announced: a subscriber told
      // about a chart the next restart cannot restore is worse than a chart
      // that briefly does not appear.
      continue
    }
    if (prior) updated.push(record)
    else created.push(record)
  }

  log('chart index rebuilt', {
    conversation_id: conversationId, rows: rows.length,
    charts: records.length, created: created.length,
    updated: updated.length, retained: retained.length, removed: removed.length,
  })
  return { records, created, updated, retained, removed }
}
