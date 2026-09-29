/**
 * log-egress-traces.ts — span records shipped as OTLP traces.
 *
 * The TypeScript twin of the engine's exporter
 * (engine/internal/utils/log_egress_traces.go): the same two record shapes
 * are recognized, with the same rules and the same attribute mapping, so a
 * span shipped by the desktop or the server looks exactly like one the engine
 * ships.
 *
 *   - a telemetry event whose payload holds span_id and duration_ms (engine
 *     spans arriving through a tailed telemetry.jsonl); its parent is
 *     context.parent_span_id.
 *   - an operational log line with tag "span" (server, desktop, web, and iOS
 *     spans); msg is the span name and fields hold span_id, parent_span_id,
 *     duration_ms, span_kind, error, and the span's attributes.
 *
 * Either way the record's ts is the span's END and top-level trace_id is its
 * trace. The otel target posts a batch's span records to /v1/traces after the
 * batch's logs are accepted. See docs/observability/log-schema.md § Spans.
 */
import { warn as _warn, debug as _debug } from './log-sink'
import type { EgressRecord, EgressOtelConfig } from './log-egress-types'
import { isTelemetryEventRecord, otlpAttrValFromAny, resourceFieldKeys, type OtlpLogAttr } from './log-egress-otel'
import { isValidSpanId, isValidTraceId, SPAN_LOG_TAG } from './trace-context'
import { egressResourceAttrs, resourceKey, resourceServiceName, serviceNameForComponent } from './log-egress-resource'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('log_egress_otel', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('log_egress_otel', msg, fields)
}

/** Span-record keys that describe the span itself rather than being its attributes. */
const RESERVED_SPAN_KEYS = new Set(['span_id', 'parent_span_id', 'duration_ms', 'error', 'span_kind'])

// OTLP span kinds and status codes (opentelemetry-proto trace.proto).
export const OTLP_SPAN_KIND_INTERNAL = 1
export const OTLP_SPAN_KIND_SERVER = 2
export const OTLP_SPAN_KIND_CLIENT = 3
export const OTLP_STATUS_UNSET = 0
export const OTLP_STATUS_ERROR = 2

/** The OTLP/JSON span subset Ion emits. Ids are lowercase hex, per the OTLP/JSON mapping. */
export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpLogAttr[]
  status: { code: number; message?: string }
}

export interface OtlpTracesExportRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpLogAttr[] }
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>
  }>
}

/** One span decoded from an egress record, with the service it belongs to. */
export interface SpanFromRecord {
  service: string
  span: OtlpSpan
}

const RFC3339_NANO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

/**
 * Parses an RFC3339 timestamp to Unix nanoseconds, keeping every fractional
 * digit (a Date keeps only milliseconds). Null when it does not parse.
 */
export function rfc3339ToUnixNano(ts: string): bigint | null {
  const m = RFC3339_NANO.exec(ts)
  if (!m) return null
  const secondsMs = Date.parse(`${m[1]}${m[3]}`)
  if (Number.isNaN(secondsMs)) return null
  const fraction = BigInt((m[2] ?? '').padEnd(9, '0') || '0')
  return BigInt(secondsMs) * 1_000_000n + fraction
}

function stringAt(src: Record<string, unknown> | undefined, key: string): string {
  const v = src?.[key]
  return typeof v === 'string' ? v : ''
}

function spanKind(v: unknown): number {
  if (v === 'server') return OTLP_SPAN_KIND_SERVER
  if (v === 'client') return OTLP_SPAN_KIND_CLIENT
  return OTLP_SPAN_KIND_INTERNAL
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** Decodes `r` as a span record. Null for any record that is not a complete, valid span. */
export function spanFromRecord(r: EgressRecord): SpanFromRecord | null {
  let src: Record<string, unknown> | undefined
  let name: string
  let parent: string
  const context = asRecord(r.context)
  if (isTelemetryEventRecord(r)) {
    src = asRecord(r.payload)
    name = typeof r.name === 'string' ? r.name : ''
    parent = stringAt(context, 'parent_span_id')
  } else if (r.tag === SPAN_LOG_TAG) {
    src = asRecord(r.fields)
    name = typeof r.msg === 'string' ? r.msg : ''
    parent = stringAt(src, 'parent_span_id')
  } else {
    return null
  }
  if (!src) return null
  const spanId = src.span_id
  const durationMs = src.duration_ms
  const end = typeof r.ts === 'string' ? rfc3339ToUnixNano(r.ts) : null
  if (!name || !isValidTraceId(r.trace_id) || !isValidSpanId(spanId) || typeof durationMs !== 'number' || end === null) {
    return null
  }
  const start = end - BigInt(Math.trunc(durationMs * 1_000_000))

  const attributes: OtlpLogAttr[] = []
  const onResource = resourceFieldKeys(r.component)
  for (const [k, v] of Object.entries(src)) {
    if (!RESERVED_SPAN_KEYS.has(k) && !onResource.has(k)) attributes.push({ key: k, value: otlpAttrValFromAny(v) })
  }
  if (r.session_id) attributes.push({ key: 'session_id', value: { stringValue: r.session_id } })
  if (r.conversation_id) attributes.push({ key: 'conversation_id', value: { stringValue: r.conversation_id } })
  for (const k of ['session_id', 'conversation_id', 'run_id']) {
    const v = stringAt(context, k)
    if (v) attributes.push({ key: k, value: { stringValue: v } })
  }
  attributes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const error = src.error
  const status = typeof error === 'string' && error
    ? { code: OTLP_STATUS_ERROR, message: error }
    : { code: OTLP_STATUS_UNSET }
  const span: OtlpSpan = {
    traceId: r.trace_id,
    spanId,
    name,
    kind: spanKind(src.span_kind),
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    attributes,
    status,
  }
  if (isValidSpanId(parent)) span.parentSpanId = parent
  return { service: serviceNameForComponent(r.component), span }
}

/**
 * Groups the span records in `records` by the resource of the source that
 * recorded them (egressResourceAttrs), so a span shares its resource with the
 * same source's logs. `resourceAttributes` is the otel config's. Null when the
 * batch holds no span.
 */
export function buildTracesExport(
  records: EgressRecord[],
  resourceAttributes?: Record<string, string>,
): { request: OtlpTracesExportRequest; count: number } | null {
  const resourceSpans: OtlpTracesExportRequest['resourceSpans'] = []
  const groupIndex = new Map<string, number>()
  let count = 0
  for (const r of records) {
    const decoded = spanFromRecord(r)
    if (!decoded) continue
    const attributes = egressResourceAttrs(r, resourceAttributes)
    const key = resourceKey(attributes)
    let i = groupIndex.get(key)
    if (i === undefined) {
      i = resourceSpans.length
      groupIndex.set(key, i)
      resourceSpans.push({ resource: { attributes }, scopeSpans: [{ scope: { name: decoded.service }, spans: [] }] })
    }
    resourceSpans[i].scopeSpans[0].spans.push(decoded.span)
    count++
  }
  if (count === 0) return null
  const byService = (a: { resource: { attributes: OtlpLogAttr[] } }): string => resourceServiceName(a.resource.attributes)
  resourceSpans.sort((a, b) => (byService(a) < byService(b) ? -1 : byService(a) > byService(b) ? 1 : 0))
  return { count, request: { resourceSpans } }
}

/**
 * Posts the batch's span records to `<endpoint>/v1/traces` with the same
 * headers as its logs. Called once the batch's logs were accepted. A failure
 * is logged, never thrown: the logs already landed, and retrying the batch
 * would ship them twice. The span line itself is still in the log backend,
 * so a lost span stays findable by trace_id.
 */
export async function shipSpansToOtel(
  records: EgressRecord[],
  cfg: EgressOtelConfig,
  authHeaders: Record<string, string>,
): Promise<void> {
  const built = buildTracesExport(records, cfg.resourceAttributes)
  if (!built) return
  try {
    const res = await fetch(cfg.endpoint.replace(/\/$/, '') + '/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.headers ?? {}), ...authHeaders },
      body: JSON.stringify(built.request),
    })
    if (res.status >= 400) {
      const body = (await res.text().catch(() => '')).slice(0, 512).trim() // silent-ok: the status alone still reports the failure
      throw new Error(body ? `POST returned status ${res.status}: ${body}` : `POST returned status ${res.status}`)
    }
  } catch (err) {
    warn('span export failed; the span lines still shipped as logs', {
      spans: built.count,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  debug('spans exported', { spans: built.count })
}
