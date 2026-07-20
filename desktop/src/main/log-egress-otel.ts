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
 * record). Alloy's ion_otlp_unwrap pipeline extracts `body` as `inner_body`
 * and rewrites the Loki log line with it, so the stored Loki line IS the
 * canonical Ion JSONL object. Dashboard queries that do `| json | device_name`
 * or `| json fields_device_name="fields.device_name"` work because the stored
 * line is a parseable JSON object, not a bare plain-text message string.
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

import { log as _log } from './logger'
import type { EgressRecord, EgressOtelConfig } from './log-egress'

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
export interface OtlpLogRecord {
  timeUnixNano: string
  severityNumber: number
  severityText: string
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
 * fields}). They arrive here because the egress tailer ships ~/.ion/telemetry.jsonl
 * verbatim (log-egress-tailer.ts). Their meaningful data lives in `name` (the
 * event kind), `payload.*` (cost/tokens/model/duration), and `context.*`
 * (extension/conversation/session) — NONE of which the operational-log attribute
 * mapper (otlpAttrsFromRecord) reads. Before this mapping, a run.complete event
 * shipped over OTLP carried a single attribute (component), silently discarding
 * every cost, kind, and attribution field — so the Cost / Runs / Extensions
 * dashboards could never populate against an OTLP-ingested backend.
 *
 * This is the OTLP counterpart of the file-tail telemetry pipeline in
 * docs/observability/alloy-config.alloy (`loki.process "ion_telemetry"`). It
 * mirrors that pipeline's stage.json field map EXACTLY so the SAME generated
 * dashboards render identically against both ingestion methods:
 *   - the OTLP body carries the verbatim event JSON, so a dashboard's
 *     `| json | unwrap payload_run_cost_usd` flattens `payload.run_cost_usd`
 *     to `payload_run_cost_usd` exactly as file-tail does on the raw line;
 *   - the flat attributes below reproduce the file-tail structured-metadata
 *     names (run_cost_usd, agg_cost_usd, cache_read_tokens, ...) so the cost
 *     pack's bare `unwrap run_cost_usd` also resolves;
 *   - `kind` and `service` are emitted so the ingestion side can promote them
 *     to the Loki stream labels the dashboards select on
 *     (`{service="ion-telemetry", kind="run.complete"}`).
 *
 * Field map is authoritative-by-mirror: docs/observability/alloy-config.alloy
 * `stage.json.expressions`. Any change there must change here (and vice versa).
 */

/** The Loki `service` label value the telemetry file-tail pipeline stamps. */
const TELEMETRY_SERVICE = 'ion-telemetry'

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
 * Build the OTLP attribute set for a telemetry EVENT record, mirroring the
 * file-tail `ion_telemetry` pipeline's stage.json field map exactly. Sorted by
 * key for determinism.
 */
export function otlpAttrsFromTelemetryEvent(r: EgressRecord): OtlpLogAttr[] {
  const rec = r as Record<string, unknown>
  const payload = (rec.payload as Record<string, unknown>) || undefined
  const context = (rec.context as Record<string, unknown>) || undefined

  const attrs: OtlpLogAttr[] = [
    // kind = name; service is the stream discriminator the dashboards select on.
    { key: 'kind', value: otlpStr(String(rec.name)) },
    { key: 'service', value: otlpStr(TELEMETRY_SERVICE) },
    { key: 'component', value: otlpStr(typeof rec.component === 'string' ? rec.component : '') },
  ]

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

  // top-level event envelope fields.
  pushIfPresent(attrs, 'trace_id', rec, 'trace_id')
  pushIfPresent(attrs, 'schema_version', rec, 'schema')
  pushIfPresent(attrs, 'install_id', rec, 'install_id')
  pushIfPresent(attrs, 'engine_version', rec, 'version')

  // context.* attribution fields.
  pushIfPresent(attrs, 'context_conversation_id', context, 'conversation_id')
  pushIfPresent(attrs, 'context_session_id', context, 'session_id')
  pushIfPresent(attrs, 'context_extension', context, 'extension')
  pushIfPresent(attrs, 'context_extension_version', context, 'extension_version')

  attrs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return attrs
}

/**
 * Flatten a record to the complete OTLP attribute set: component and tag
 * always; each present correlation ID and user; and every key in the fields
 * map (run_id rides here). Sorted by key so the desktop and engine exporters
 * produce identical output for the same record.
 */
export function otlpAttrsFromRecord(r: EgressRecord): OtlpLogAttr[] {
  const attrs: OtlpLogAttr[] = [
    { key: 'component', value: otlpStr(r.component) },
  ]
  if (r.tag) attrs.push({ key: 'tag', value: otlpStr(r.tag) })
  if (r.session_id) attrs.push({ key: 'session_id', value: otlpStr(r.session_id) })
  if (r.conversation_id) attrs.push({ key: 'conversation_id', value: otlpStr(r.conversation_id) })
  if (r.trace_id) attrs.push({ key: 'trace_id', value: otlpStr(r.trace_id) })
  if (r.user) attrs.push({ key: 'user', value: otlpStr(r.user) })
  if (r.fields) {
    for (const [k, v] of Object.entries(r.fields)) {
      attrs.push({ key: k, value: otlpAttrValFromAny(v) })
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
export function buildOtlpPayload(records: EgressRecord[], serviceName: string): OtlpLogsExportRequest {
  const otlpRecords: OtlpLogRecord[] = []
  let skipped = 0
  for (const r of records) {
    try {
      let tsNano = ''
      try {
        tsNano = String(new Date(r.ts).getTime() * 1_000_000)
      } catch { /* silent-ok: unparseable record timestamp; leave tsNano empty */ }

      if (isTelemetryEventRecord(r)) {
        // TELEMETRY EVENT record. Its data lives in name/payload/context, NOT in
        // msg/level/fields, so the operational mapper would drop everything but
        // component. Map it through the file-tail mirror instead:
        //   - body = the verbatim event JSON. A dashboard's
        //     `| json | unwrap payload_run_cost_usd` flattens payload.run_cost_usd
        //     to payload_run_cost_usd exactly as the file-tail raw line does.
        //   - attributes = the flat file-tail label/metadata set (kind, service,
        //     run_cost_usd, ...).
        //   - loki.attribute.labels hint promotes service+kind (+component) to
        //     Loki STREAM LABELS so `{service="ion-telemetry", kind="run.complete"}`
        //     selects the stream. otelcol.exporter.loki does not promote OTLP
        //     attributes to labels without this hint; non-promoted attributes
        //     become Loki structured metadata (so `| unwrap run_cost_usd` also
        //     resolves), matching the file-tail representation.
        const attrs = otlpAttrsFromTelemetryEvent(r)
        attrs.push({ key: 'loki.attribute.labels', value: otlpStr('service, kind, component') })
        attrs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        otlpRecords.push({
          timeUnixNano: tsNano,
          severityNumber: otlpSeverityNumber(r.level),
          severityText: normalizeSeverityText(r.level),
          body: { stringValue: telemetryEventBody(r) },
          attributes: attrs,
        })
        continue
      }

      // OPERATIONAL log record. Body is the full serialized Ion JSONL line so
      // Alloy's ion_otlp_unwrap pipeline rewrites the stored Loki line to a
      // parseable JSON object (not a bare plain-text msg string). Dashboard
      // queries that use `| json` — including the mobile pack's device_name /
      // device_id / app_version filtering — work because the body is valid JSON.
      //
      // `level` is normalized so a missing level never throws; JSON.stringify
      // falls back to the bare msg on pathological records so one bad record
      // never breaks the batch flush.
      //
      // loki.attribute.labels promotes component+tag to Loki stream labels so
      // the operational panels that select on them — "Log volume by component"
      // (`{component=~".+"}`) and "Extension activity" (`{component="extension"}`)
      // — resolve against the OTLP-ingested backend exactly as they do against
      // the file-tail backend. Harmless (idempotent) if the ingestion side
      // already promotes them.
      const opAttrs = otlpAttrsFromRecord(r)
      opAttrs.push({ key: 'loki.attribute.labels', value: otlpStr('component, tag') })
      opAttrs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      let opBody: string
      try {
        opBody = JSON.stringify(r)
      } catch {
        opBody = typeof r.msg === 'string' ? r.msg : ''
      }
      otlpRecords.push({
        timeUnixNano: tsNano,
        severityNumber: otlpSeverityNumber(r.level),
        severityText: normalizeSeverityText(r.level),
        body: { stringValue: opBody },
        attributes: opAttrs,
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
      shipped: otlpRecords.length,
      total: records.length,
    })
  }

  return {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
      },
      scopeLogs: [{
        scope: { name: serviceName },
        logRecords: otlpRecords,
      }],
    }],
  }
}

/**
 * Export a batch of records to the OTLP /v1/logs endpoint. Throws on a non-2xx
 * response so the caller's spool/backoff path engages.
 */
export async function flushToOtel(
  records: EgressRecord[],
  cfg: EgressOtelConfig,
  authHeaders: Record<string, string>,
): Promise<void> {
  if (!cfg.endpoint) throw new Error('log egress otel: endpoint not configured')
  const serviceName = cfg.serviceName || 'ion-desktop'

  const payload = buildOtlpPayload(records, serviceName)

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
}
