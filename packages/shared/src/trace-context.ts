/**
 * trace-context — W3C trace-context ids and a small span API shared by every
 * TypeScript surface (Studio renderer, Studio in a browser, the Ion server,
 * Electron main).
 *
 * A trace follows one prompt across processes: the client mints the trace
 * and its root span, hands `traceparent` to the next hop, and each hop
 * records its own span as a child. The parse rules match the engine's
 * (`engine/internal/utils/traceparent.go`), so a value one side accepts the
 * other accepts too.
 *
 * This module writes nothing itself. A span's `end()` hands a `SpanRecord` to
 * the writer the caller supplied, and each surface's writer turns it into a
 * span log line through that surface's own logger (`spanLogFields`). See
 * docs/observability/log-schema.md § Spans.
 */

const TRACE_ID_HEX_LEN = 32
const SPAN_ID_HEX_LEN = 16

/** The tag that marks an operational log line as a span record. */
export const SPAN_LOG_TAG = 'span'

/** A parsed `traceparent`: the trace and the span that is the next hop's parent. */
export interface TraceParent {
  traceId: string
  spanId: string
}

export type SpanKind = 'server' | 'client' | 'internal'

/** One finished span, as `end()` hands it to a writer. */
export interface SpanRecord {
  name: string
  traceId: string
  spanId: string
  /** Absent for a root span. */
  parentSpanId?: string
  kind: SpanKind
  /** Wall-clock milliseconds since the epoch. */
  startMs: number
  endMs: number
  durationMs: number
  attributes: Record<string, unknown>
  /** Present when the span failed; marks the exported span's status as error. */
  error?: string
}

export type SpanWriter = (record: SpanRecord) => void

export interface StartSpanOptions {
  /** Where the finished span goes. Each surface supplies one bound to its own logger. */
  writer: SpanWriter
  /** The caller's span, as ids or a `traceparent` value. Absent or invalid starts a new trace. */
  parent?: TraceParent | string
  kind?: SpanKind
  attributes?: Record<string, unknown>
  /** Clock override (test use). Wall-clock milliseconds. */
  now?: () => number
}

export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  /** This span as the parent of the next hop's span. */
  traceparent: string
  /** True when the span joined the caller's trace; false when it started a new one. */
  joined: boolean
  /**
   * Finishes the span and hands its record to the writer. Idempotent: only the
   * first call writes, and later calls return undefined.
   */
  end(extraAttributes?: Record<string, unknown>, error?: string): SpanRecord | undefined
}

function isLowerHexId(id: string, n: number): boolean {
  return id.length === n && /^[0-9a-f]+$/.test(id) && !/^0+$/.test(id)
}

/** A W3C trace-id: 32 lowercase hex characters, not all zero. */
export function isValidTraceId(id: unknown): id is string {
  return typeof id === 'string' && isLowerHexId(id, TRACE_ID_HEX_LEN)
}

/** A W3C span-id: 16 lowercase hex characters, not all zero. */
export function isValidSpanId(id: unknown): id is string {
  return typeof id === 'string' && isLowerHexId(id, SPAN_ID_HEX_LEN)
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

function randomId(bytes: number, valid: (id: string) => boolean): string {
  // An all-zero id is invalid; the odds are 2^-64 or less, so one redraw is plenty in practice.
  for (;;) {
    const id = randomHex(bytes)
    if (valid(id)) return id
  }
}

/** A fresh W3C trace-id (32 lowercase hex). */
export function newTraceId(): string {
  return randomId(TRACE_ID_HEX_LEN / 2, isValidTraceId)
}

/** A fresh W3C span-id (16 lowercase hex). */
export function newSpanId(): string {
  return randomId(SPAN_ID_HEX_LEN / 2, isValidSpanId)
}

/** A sampled W3C `traceparent` value. */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`
}

/**
 * Parses a `traceparent` (`00-<trace-id>-<parent-id>-<flags>`). Null for any
 * value that is not version 00 with a valid trace-id and span-id; the caller
 * starts its own trace in that case.
 */
export function parseTraceparent(value: unknown): TraceParent | null {
  if (typeof value !== 'string') return null
  const parts = value.trim().split('-')
  if (parts.length !== 4 || parts[0] !== '00' || parts[3].length !== 2) return null
  if (!isValidTraceId(parts[1]) || !isValidSpanId(parts[2])) return null
  return { traceId: parts[1], spanId: parts[2] }
}

function resolveParent(parent: TraceParent | string | undefined): TraceParent | null {
  if (parent === undefined) return null
  if (typeof parent === 'string') return parseTraceparent(parent)
  return isValidTraceId(parent.traceId) && isValidSpanId(parent.spanId) ? parent : null
}

/** Starts a span. It joins `parent`'s trace when that is valid, and starts a new trace otherwise. */
export function startSpan(name: string, opts: StartSpanOptions): Span {
  const now = opts.now ?? Date.now
  const parent = resolveParent(opts.parent)
  const traceId = parent?.traceId ?? newTraceId()
  const spanId = newSpanId()
  const startMs = now()
  const kind = opts.kind ?? 'internal'
  let ended = false
  return {
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    traceparent: formatTraceparent(traceId, spanId),
    joined: parent !== null,
    end(extraAttributes, error) {
      if (ended) return undefined
      ended = true
      const endMs = now()
      const record: SpanRecord = {
        name,
        traceId,
        spanId,
        kind,
        startMs,
        endMs,
        durationMs: Math.max(0, endMs - startMs),
        attributes: { ...(opts.attributes ?? {}), ...(extraAttributes ?? {}) },
      }
      if (parent) record.parentSpanId = parent.spanId
      if (error) record.error = error
      opts.writer(record)
      return record
    },
  }
}

/**
 * The `fields` of a span's log line: the span's own keys plus its attributes.
 * `trace_id` rides here so the surface's logger lifts it to the line's
 * top-level `trace_id`; the line is written with tag `SPAN_LOG_TAG` and the
 * span name as `msg`, at the span's end, so the line's `ts` is the span's end.
 * Attributes never overwrite the span's own keys.
 */
export function spanLogFields(record: SpanRecord): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...record.attributes }
  fields.trace_id = record.traceId
  fields.span_id = record.spanId
  if (record.parentSpanId) fields.parent_span_id = record.parentSpanId
  else delete fields.parent_span_id
  fields.duration_ms = record.durationMs
  fields.span_kind = record.kind
  if (record.error) fields.error = record.error
  else delete fields.error
  return fields
}
