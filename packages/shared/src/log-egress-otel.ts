/**
 * log-egress-otel.ts — OTLP /v1/logs serialization for the desktop egress
 * forwarder.
 *
 * Extracted from log-egress.ts (600-line cap). This module owns the OTLP wire
 * types and the LOSSLESS record→OTLP mapping: the full serialized Ion JSONL
 * line as the record body; and component, tag, every present correlation ID,
 * user, and every flattened fields key as attributes.
 *
 * Body design: the body carries the full JSONL line (JSON.stringify of the
 * record), so a consumer reads it as the same JSON object the local file
 * holds (`| json` in LogQL, parse_json(Body) in KQL).
 *
 * The typing convention is native-scalar and is shared byte-for-byte with the
 * engine exporter (engine/internal/utils/log_egress.go), so engine and desktop
 * OTLP output is structurally identical for the same canonical record:
 *   - string             -> stringValue
 *   - bool               -> boolValue
 *   - integer            -> intValue (int64 rendered as a decimal string, per
 *                           the OTLP/JSON protobuf mapping)
 *   - non-integer number -> doubleValue
 *   - nested object/array -> JSON-stringified into stringValue
 * A whole-valued number (e.g. 5 or 5.0) is emitted as intValue so a record
 * that survived a JSON spool round-trip serializes identically to a live one.
 *
 * run_id is NOT a top-level correlation ID; per the operational log schema it
 * rides inside the fields map and is flattened to an attribute like any other
 * fields key — carried losslessly, never dropped.
 */

import { log as _log } from './log-sink'
import type { EgressRecord, EgressOtelConfig } from './log-egress'
import { defaultEgressServiceName } from './log-egress-process'
import { shipSpansToOtel } from './log-egress-traces'
import { egressResourceAttrs, logRecordTraceIds, resourceKey } from './log-egress-resource'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('log_egress_otel', msg, fields)
}

// ---------------------------------------------------------------------------
// OTLP wire types (minimal subset for /v1/logs)
// ---------------------------------------------------------------------------

export interface OtlpLogAttrVal {
  stringValue?: string
  boolValue?: boolean
  intValue?: string
  doubleValue?: number
}
export interface OtlpLogAttr {
  key: string
  value: OtlpLogAttrVal
}
/**
 * traceId and spanId are the OTLP LogRecord fields (lowercase hex), where
 * Application Insights reads a log's operation (OTelLogs TraceId/SpanId). They
 * are the only place a shipped record states its trace and span.
 */
export interface OtlpLogRecord {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  traceId?: string
  spanId?: string
  body: { stringValue: string }
  attributes: OtlpLogAttr[]
}
export interface OtlpScopeLogs {
  scope: { name: string }
  logRecords: OtlpLogRecord[]
}
export interface OtlpResourceLogs {
  resource: { attributes: OtlpLogAttr[] }
  scopeLogs: OtlpScopeLogs[]
}
export interface OtlpLogsExportRequest {
  resourceLogs: OtlpResourceLogs[]
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Default severity text for a record whose `level` field is absent or empty.
 * Not every line that reaches this serializer is an operational log record: the
 * tailer ships ~/.ion/telemetry.jsonl verbatim, and those cost-telemetry event
 * records ({name, ts, schema, payload, ...}) carry no `level` and no `msg`. A
 * missing level must map to a sane default (INFO / severityNumber 9) exactly as
 * the engine exporter's `otlpLogSeverityNumber` does via its switch `default`
 * (engine/internal/utils/log_egress.go) — where a missing Go field is the empty
 * string "" and falls through to the same default. The desktop's field is
 * `undefined`, so it must be normalized here rather than dereferenced blindly:
 * `undefined.toUpperCase()` throws and would abort the entire batch flush.
 */
const DEFAULT_SEVERITY_TEXT = 'INFO'

/**
 * Normalize a record's `level` to a non-empty uppercase severity string. A
 * missing, empty, or non-string level (telemetry event records, malformed
 * lines) maps to DEFAULT_SEVERITY_TEXT rather than throwing. This is the guard
 * that keeps one mis-shaped spooled record from wedging the whole spool drain.
 */
export function normalizeSeverityText(level: unknown): string {
  if (typeof level === 'string' && level.trim().length > 0) {
    return level.toUpperCase()
  }
  return DEFAULT_SEVERITY_TEXT
}

export function otlpSeverityNumber(level: unknown): number {
  switch (normalizeSeverityText(level)) {
    case 'TRACE': return 1
    case 'DEBUG': return 5
    case 'INFO': return 9
    case 'WARN': return 13
    case 'ERROR': return 17
    default: return 9
  }
}

/** String-valued OTLP attribute value. */
function otlpStr(s: string): OtlpLogAttrVal {
  return { stringValue: s }
}

/**
 * The OTLP body for a telemetry event: the verbatim event JSON. The tailer
 * parsed the original telemetry.jsonl line into this record via JSON.parse
 * (log-egress-tailer.ts processChunk), so JSON.stringify reproduces the same
 * object graph — {name, ts, schema, component, payload:{...}, context:{...}} —
 * that the file-tail pipeline ingests as the raw line. A dashboard's
 * `| json | unwrap payload_run_cost_usd` therefore flattens `payload.run_cost_usd`
 * to `payload_run_cost_usd` identically on both ingestion paths. Never throws:
 * a value that fails to stringify (circular ref) falls back to an empty body,
 * leaving the flat attributes as the queryable surface.
 */
export function telemetryEventBody(r: EgressRecord): string {
  try {
    return JSON.stringify(r)
  } catch {
    return ''
  }
}

/** Integer-valued OTLP attribute value (int64 rendered as a decimal string). */
function otlpInt(n: number): OtlpLogAttrVal {
  return { intValue: String(Math.trunc(n)) }
}

/**
 * Convert an arbitrary fields value to its OTLP AnyValue representation using
 * the native-scalar convention (shared byte-for-byte with the engine). Nested
 * objects and arrays are JSON-stringified. Whole-valued numbers are promoted
 * to intValue for spool-round-trip stability.
 */
export function otlpAttrValFromAny(v: unknown): OtlpLogAttrVal {
  if (v === null || v === undefined) return otlpStr('')
  switch (typeof v) {
    case 'string':
      return otlpStr(v)
    case 'boolean':
      return { boolValue: v }
    case 'number':
      if (Number.isFinite(v) && Number.isInteger(v)) return otlpInt(v)
      return { doubleValue: v }
    case 'bigint':
      return { intValue: v.toString() }
    default:
      // Nested object, array, or any other composite: JSON-stringify.
      try {
        return otlpStr(JSON.stringify(v))
      } catch {
        return otlpStr(String(v))
      }
  }
}

/**
 * Telemetry EVENT records ({name, ts, schema, component, payload, context})
 * are a distinct shape from operational log records ({ts, level, msg, ...,
 * fields}). They arrive here because the egress tailer expands
 * ~/.ion/telemetry.jsonl into one record per event (log-egress-tailer.ts).
 * Their data lives in `name` (the event kind), `payload.*`
 * (cost/tokens/model/duration), and `context.*` (extension, conversation,
 * session), none of which the operational mapper reads.
 *
 * An event is an OTel event: its name is the `event.name` attribute, which is
 * also what tells it from an operational line (no fields key is dotted). The
 * event's install, version, and host are its resource (log-egress-resource.ts)
 * and its trace is the LogRecord traceId, so none of those is an attribute.
 * The payload and context names mirror the local stack's telemetry pipeline
 * (docs/observability/alloy-config.alloy, `loki.process "ion_telemetry"`) and
 * are byte-identical with the engine exporter
 * (engine/internal/utils/log_egress_otel.go).
 */

/** The OTel attribute naming a telemetry event. */
export const EVENT_NAME_ATTR = 'event.name'

/**
 * A record is a telemetry EVENT (not an operational log line) when it carries a
 * string `name` and an object `payload`. Operational log records never have a
 * top-level `name` or `payload`; telemetry events always do and carry no
 * `msg`/`level`. This is the discriminator the serializer branches on.
 */
export function isTelemetryEventRecord(r: EgressRecord): boolean {
  const name = (r as Record<string, unknown>).name
  const payload = (r as Record<string, unknown>).payload
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    payload != null &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  )
}

/**
 * Push an attribute for `key` sourced from `src[srcKey]`, but only when the
 * value is present (not undefined/null) — mirroring the file-tail pipeline,
 * where a missing JSON field simply yields no label/metadata. A present zero or
 * false IS emitted (they are valid telemetry values), via otlpAttrValFromAny.
 */
function pushIfPresent(
  attrs: OtlpLogAttr[],
  key: string,
  src: Record<string, unknown> | undefined,
  srcKey: string,
): void {
  if (!src) return
  const v = src[srcKey]
  if (v === undefined || v === null) return
  attrs.push({ key, value: otlpAttrValFromAny(v) })
}

/**
 * The OTLP attribute set for a telemetry EVENT record: event.name, user, the
 * payload and context keys the local telemetry pipeline extracts, and the
 * telemetry schema version. Sorted by key for determinism and engine parity.
 */
export function otlpAttrsFromTelemetryEvent(r: EgressRecord): OtlpLogAttr[] {
  const rec = r as Record<string, unknown>
  const payload = (rec.payload as Record<string, unknown>) || undefined
  const context = (rec.context as Record<string, unknown>) || undefined

  const attrs: OtlpLogAttr[] = [{ key: EVENT_NAME_ATTR, value: otlpStr(String(rec.name)) }]
  if (typeof rec.user === 'string' && rec.user) attrs.push({ key: 'user', value: otlpStr(rec.user) })

  // payload.* — names mirror alloy-config.alloy stage.json (renames included).
  pushIfPresent(attrs, 'model', payload, 'model')
  pushIfPresent(attrs, 'tool', payload, 'tool')
  pushIfPresent(attrs, 'stop_reason', payload, 'stop_reason')
  pushIfPresent(attrs, 'duration_ms', payload, 'duration_ms')
  pushIfPresent(attrs, 'run_cost_usd', payload, 'run_cost_usd')
  pushIfPresent(attrs, 'agg_cost_usd', payload, 'aggregate_cost_usd')
  pushIfPresent(attrs, 'dispatch_depth', payload, 'dispatch_depth')
  pushIfPresent(attrs, 'num_turns', payload, 'num_turns')
  pushIfPresent(attrs, 'input_tokens', payload, 'input_tokens')
  pushIfPresent(attrs, 'output_tokens', payload, 'output_tokens')
  pushIfPresent(attrs, 'cache_read_tokens', payload, 'cache_read_input_tokens')
  pushIfPresent(attrs, 'cache_creation_tokens', payload, 'cache_creation_input_tokens')
  pushIfPresent(attrs, 'error', payload, 'error')

  pushIfPresent(attrs, 'schema_version', rec, 'schema')

  // context.* attribution fields.
  pushIfPresent(attrs, 'context_conversation_id', context, 'conversation_id')
  pushIfPresent(attrs, 'context_session_id', context, 'session_id')
  pushIfPresent(attrs, 'context_extension', context, 'extension')
  pushIfPresent(attrs, 'context_extension_version', context, 'extension_version')

  attrs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return attrs
}

/**
 * The fields keys a record's resource already states (egressResourceAttrs):
 * the host is host.name and the install is service.instance.id; on an iOS
 * line the device is service.instance.id and the app build is
 * service.version. span_id is the LogRecord's spanId. None is repeated as an
 * attribute. Mirrors the engine's resourceFieldKeys.
 */
export function resourceFieldKeys(component: unknown): ReadonlySet<string> {
  return component === 'ios'
    ? new Set(['span_id', 'device_id', 'app_version'])
    : new Set(['span_id', 'host', 'install_id'])
}

/**
 * Flatten an operational record to its OTLP attribute set: tag; each present
 * session, conversation, and user id; event_id; and every fields key (run_id
 * rides here) except those the resource or the LogRecord already carry. The
 * component is the resource's service.name and the trace is the LogRecord
 * traceId, so neither is an attribute. Sorted by key so the desktop and engine
 * exporters produce identical output for the same record.
 */
export function otlpAttrsFromRecord(r: EgressRecord): OtlpLogAttr[] {
  const attrs: OtlpLogAttr[] = [{ key: 'tag', value: otlpStr(r.tag ?? '') }]
  if (r.session_id) attrs.push({ key: 'session_id', value: otlpStr(r.session_id) })
  if (r.conversation_id) attrs.push({ key: 'conversation_id', value: otlpStr(r.conversation_id) })
  if (r.user) attrs.push({ key: 'user', value: otlpStr(r.user) })
  if (typeof r.event_id === 'string' && r.event_id) attrs.push({ key: 'event_id', value: otlpStr(r.event_id) })
  if (r.fields) {
    const skip = resourceFieldKeys(r.component)
    for (const [k, v] of Object.entries(r.fields)) {
      if (!skip.has(k)) attrs.push({ key: k, value: otlpAttrValFromAny(v) })
    }
  }
  attrs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return attrs
}

/**
 * Build the full OTLP export request for a batch of records. Pure — no
 * networking. Exported so tests can assert the exact wire shape without a
 * fetch mock, and so the engine-parity test can compare against the engine's
 * attribute set.
 */
export function buildOtlpPayload(
  records: EgressRecord[],
  serviceName: string,
  resourceAttributes?: Record<string, string>,
): OtlpLogsExportRequest {
  // One resourceLogs entry per source resource, in first-seen order. The
  // scope names the exporter; each resource names the source that wrote it.
  const resourceLogs: OtlpResourceLogs[] = []
  const groupIndex = new Map<string, number>()
  const add = (r: EgressRecord, rec: OtlpLogRecord): void => {
    const { traceId, spanId } = logRecordTraceIds(r)
    // Key order matches the engine exporter's wire output.
    const placed: OtlpLogRecord = {
      timeUnixNano: rec.timeUnixNano,
      severityNumber: rec.severityNumber,
      severityText: rec.severityText,
      ...(traceId ? { traceId } : {}),
      ...(spanId ? { spanId } : {}),
      body: rec.body,
      attributes: rec.attributes,
    }
    const attributes = egressResourceAttrs(r, resourceAttributes)
    const key = resourceKey(attributes)
    let i = groupIndex.get(key)
    if (i === undefined) {
      i = resourceLogs.length
      groupIndex.set(key, i)
      resourceLogs.push({ resource: { attributes }, scopeLogs: [{ scope: { name: serviceName }, logRecords: [] }] })
    }
    resourceLogs[i].scopeLogs[0].logRecords.push(placed)
  }
  let skipped = 0
  for (const r of records) {
    try {
      let tsNano = ''
      try {
        tsNano = String(new Date(r.ts).getTime() * 1_000_000)
      } catch { /* silent-ok: unparseable record timestamp; leave tsNano empty */ }

      if (isTelemetryEventRecord(r)) {
        // TELEMETRY EVENT record: body is the verbatim event JSON, the
        // attributes are the event's (otlpAttrsFromTelemetryEvent).
        add(r, {
          timeUnixNano: tsNano,
          severityNumber: otlpSeverityNumber(r.level),
          severityText: normalizeSeverityText(r.level),
          body: { stringValue: telemetryEventBody(r) },
          attributes: otlpAttrsFromTelemetryEvent(r),
        })
        continue
      }

      // OPERATIONAL log record. Body is the full serialized Ion JSONL line, a
      // parseable JSON object a consumer's `| json` reads. `level` is
      // normalized so a missing level never throws; JSON.stringify falls back
      // to the bare msg on pathological records so one bad record never
      // breaks the batch flush.
      let opBody: string
      try {
        opBody = JSON.stringify(r)
      } catch {
        opBody = typeof r.msg === 'string' ? r.msg : ''
      }
      add(r, {
        timeUnixNano: tsNano,
        severityNumber: otlpSeverityNumber(r.level),
        severityText: normalizeSeverityText(r.level),
        body: { stringValue: opBody },
        attributes: otlpAttrsFromRecord(r),
      })
    } catch (err) {
      // A single mis-shaped record must not abort the batch — skip it so the
      // rest of the spool still ships. This is defense-in-depth beneath the
      // field-level normalization above; if it ever fires, the record shape is
      // pathological and worth an operational log line.
      skipped++
      log('otlp record skipped: unmappable record', {
        error: err instanceof Error ? err.message : String(err),
        component: typeof r?.component === 'string' ? r.component : '(unknown)',
      })
    }
  }

  if (skipped > 0) {
    log('otlp batch built with skipped records', {
      skipped,
      shipped: records.length - skipped,
      total: records.length,
    })
  }

  return { resourceLogs }
}

/**
 * Export a batch of records to the OTLP /v1/logs endpoint. Throws on a non-2xx
 * response so the caller's spool/backoff path engages. Once the logs are
 * accepted, the batch's span records go to /v1/traces (log-egress-traces.ts);
 * a span export failure is logged and never fails the batch.
 */
export async function flushToOtel(
  records: EgressRecord[],
  cfg: EgressOtelConfig,
  authHeaders: Record<string, string>,
): Promise<void> {
  if (!cfg.endpoint) throw new Error('log egress otel: endpoint not configured')
  const serviceName = cfg.serviceName || defaultEgressServiceName()

  const payload = buildOtlpPayload(records, serviceName, cfg.resourceAttributes)

  const endpoint = cfg.endpoint.replace(/\/$/, '') + '/v1/logs'
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.headers ?? {}),
      ...authHeaders,
    },
    body: JSON.stringify(payload),
  })
  if (res.status >= 400) {
    throw new Error(`log egress otel: POST returned status ${res.status}`)
  }
  await shipSpansToOtel(records, cfg, authHeaders)
}
