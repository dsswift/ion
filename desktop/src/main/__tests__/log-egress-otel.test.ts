/**
 * log-egress-otel.test.ts — tests for the LOSSLESS OTLP egress serializer
 * (Part G2), mirroring the engine table test
 * (engine/internal/utils/log_egress_otel_test.go).
 *
 * The serializer must carry the COMPLETE canonical record to every OTLP log
 * record: the full serialized Ion JSONL as the body (so Alloy's ion_otlp_unwrap
 * pipeline can rewrite the Loki line to a parseable JSON object); and
 * component/tag and every present correlation ID + user as attributes; and
 * every key in the fields map flattened to a natively-typed attribute
 * (string/bool/int/double scalars; JSON-stringified nested objects/arrays).
 * Nothing is dropped.
 *
 * The parity block pins that the desktop output for a canonical record has the
 * IDENTICAL attribute keys and value types the engine produces for the same
 * record — the engine↔desktop byte-shape guarantee.
 */

import { describe, it, expect } from 'vitest'
import type { EgressRecord } from '../log-egress'
import {
  buildOtlpPayload,
  otlpAttrsFromRecord,
  otlpAttrsFromTelemetryEvent,
  otlpAttrValFromAny,
  otlpSeverityNumber,
  normalizeSeverityText,
  isTelemetryEventRecord,
  telemetryEventBody,
  OtlpLogAttr,
  OtlpLogAttrVal,
} from '../log-egress-otel'

// canonicalRecord is the fixture pinned by both this test and the engine table
// test. It carries a mixed-scalar + nested fields map, all three populated
// top-level correlation IDs, and user. run_id lives inside fields (per the
// operational schema) and must survive as its own attribute.
function canonicalRecord(): EgressRecord {
  return {
    ts: '2024-11-15T22:04:05.123456789Z',
    level: 'INFO',
    msg: 'session started',
    component: 'engine',
    tag: 'session',
    session_id: 'sess-abc',
    conversation_id: '1780093348767-c1c03e998388',
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    user: 'user@example.com',
    fields: {
      run_id: 'run-xyz',
      model: 'claude-opus-4-5',
      turn: 3,
      cost_usd: 0.0123,
      cache_hit: true,
      duration_ms: 42,
      nested: { a: 1, b: 'two' },
      list: ['x', 'y', 'z'],
      whole_float: 5.0,
    },
  }
}

function attrMap(attrs: OtlpLogAttr[]): Record<string, OtlpLogAttrVal> {
  const m: Record<string, OtlpLogAttrVal> = {}
  for (const a of attrs) {
    expect(m[a.key], `duplicate attribute key ${a.key}`).toBeUndefined()
    m[a.key] = a.value
  }
  return m
}

describe('OTLP lossless serialization', () => {
  it('every canonical key becomes a native-typed attribute', () => {
    const rec = canonicalRecord()
    const attrs = attrMap(otlpAttrsFromRecord(rec))

    // Expected attribute set: component, tag, three correlation IDs, user, and
    // every fields key (run_id included). Missing or extra key fails.
    const wantKeys = [
      'component', 'tag',
      'session_id', 'conversation_id', 'trace_id', 'user',
      'run_id', 'model', 'turn', 'cost_usd', 'cache_hit',
      'duration_ms', 'nested', 'list', 'whole_float',
    ].sort()
    expect(Object.keys(attrs).sort()).toEqual(wantKeys)

    // Native typing.
    expect(attrs.component).toEqual({ stringValue: 'engine' })
    expect(attrs.tag).toEqual({ stringValue: 'session' })
    expect(attrs.session_id).toEqual({ stringValue: 'sess-abc' })
    expect(attrs.conversation_id).toEqual({ stringValue: '1780093348767-c1c03e998388' })
    expect(attrs.trace_id).toEqual({ stringValue: '4bf92f3577b34da6a3ce929d0e0e4736' })
    expect(attrs.user).toEqual({ stringValue: 'user@example.com' })
    // run_id rides inside fields but surfaces as its own attribute.
    expect(attrs.run_id).toEqual({ stringValue: 'run-xyz' })
    expect(attrs.model).toEqual({ stringValue: 'claude-opus-4-5' })
    // Integer scalar → intValue string.
    expect(attrs.turn).toEqual({ intValue: '3' })
    expect(attrs.duration_ms).toEqual({ intValue: '42' })
    // Non-integer number → doubleValue.
    expect(attrs.cost_usd).toEqual({ doubleValue: 0.0123 })
    // bool → boolValue.
    expect(attrs.cache_hit).toEqual({ boolValue: true })
    // Whole-valued number → intValue (spool round-trip stability).
    expect(attrs.whole_float).toEqual({ intValue: '5' })
    // Nested object / array → JSON-stringified stringValue.
    expect(JSON.parse(attrs.nested.stringValue!)).toEqual({ a: 1, b: 'two' })
    expect(JSON.parse(attrs.list.stringValue!)).toEqual(['x', 'y', 'z'])
  })

  it('body is the full JSONL; severity maps correctly', () => {
    const payload = buildOtlpPayload([canonicalRecord()], 'ion-desktop')
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0]
    // Body must be the full serialized JSONL — parseable JSON containing msg, component, tag.
    const parsed = JSON.parse(lr.body.stringValue)
    expect(parsed.msg).toBe('session started')
    expect(parsed.component).toBe('engine')
    expect(parsed.tag).toBe('session')
    // Must not be just the bare msg string.
    expect(lr.body.stringValue).not.toBe('session started')
    expect(lr.severityText).toBe('INFO')
    expect(lr.severityNumber).toBe(9)
  })

  it('omits absent correlation IDs and user', () => {
    const rec: EgressRecord = {
      ts: '2024-11-15T22:04:05.123456789Z',
      level: 'WARN',
      msg: 'socket already exists',
      component: 'engine',
      tag: 'server',
      fields: { path: '/tmp/x.sock' },
    }
    const attrs = attrMap(otlpAttrsFromRecord(rec))
    for (const absent of ['session_id', 'conversation_id', 'trace_id', 'user']) {
      expect(attrs[absent], `${absent} must be omitted when not in scope`).toBeUndefined()
    }
    expect(attrs.component).toEqual({ stringValue: 'engine' })
    expect(attrs.tag).toEqual({ stringValue: 'server' })
    expect(attrs.path).toEqual({ stringValue: '/tmp/x.sock' })
  })

  it('is stable across a JSON spool round-trip', () => {
    const live = canonicalRecord()
    const roundTripped = JSON.parse(JSON.stringify(live)) as EgressRecord

    const liveAttrs = attrMap(otlpAttrsFromRecord(live))
    const rtAttrs = attrMap(otlpAttrsFromRecord(roundTripped))
    expect(rtAttrs).toEqual(liveAttrs)
  })

  it('maps every level to its severity number', () => {
    const cases: Array<[string, number]> = [
      ['TRACE', 1], ['DEBUG', 5], ['INFO', 9], ['WARN', 13], ['ERROR', 17],
    ]
    for (const [level, num] of cases) {
      expect(otlpSeverityNumber(level)).toBe(num)
    }
  })

  it('attribute list is sorted by key (deterministic, engine-parity)', () => {
    const attrs = otlpAttrsFromRecord(canonicalRecord())
    const keys = attrs.map((a) => a.key)
    const sorted = [...keys].sort()
    expect(keys).toEqual(sorted)
  })
})

// ---------------------------------------------------------------------------
// Engine↔desktop parity assertion
// ---------------------------------------------------------------------------

/**
 * ENGINE_CANONICAL_ATTRS is the attribute set the engine exporter produces for
 * the identical canonical record, pinned in
 * engine/internal/utils/log_egress_otel_test.go
 * (TestOtelExporterLossless_EveryKeyBecomesAttribute). It is reproduced here as
 * the parity oracle: the desktop serializer must produce the same keys with the
 * same value types. If either side changes its typing convention, this test
 * fails and forces both sides back into agreement.
 *
 * Values are matched structurally (same discriminant field + value), which is
 * exactly what "byte-shape parity for the same canonical record" means for the
 * OTLP AnyValue encoding.
 */
const ENGINE_CANONICAL_ATTRS: Record<string, OtlpLogAttrVal> = {
  component: { stringValue: 'engine' },
  tag: { stringValue: 'session' },
  session_id: { stringValue: 'sess-abc' },
  conversation_id: { stringValue: '1780093348767-c1c03e998388' },
  trace_id: { stringValue: '4bf92f3577b34da6a3ce929d0e0e4736' },
  user: { stringValue: 'user@example.com' },
  run_id: { stringValue: 'run-xyz' },
  model: { stringValue: 'claude-opus-4-5' },
  turn: { intValue: '3' },
  duration_ms: { intValue: '42' },
  cost_usd: { doubleValue: 0.0123 },
  cache_hit: { boolValue: true },
  whole_float: { intValue: '5' },
  // Nested/array compared via parsed JSON below (key presence + string type).
  nested: { stringValue: '{"a":1,"b":"two"}' },
  list: { stringValue: '["x","y","z"]' },
}

describe('engine↔desktop OTLP parity', () => {
  it('desktop output matches the engine attribute set for the canonical record', () => {
    const desktopAttrs = attrMap(otlpAttrsFromRecord(canonicalRecord()))

    // Same key set.
    expect(Object.keys(desktopAttrs).sort()).toEqual(Object.keys(ENGINE_CANONICAL_ATTRS).sort())

    // Same value shape per key. Nested/array are compared as parsed JSON so
    // key-ordering inside the stringified blob doesn't create a false mismatch.
    for (const [key, engineVal] of Object.entries(ENGINE_CANONICAL_ATTRS)) {
      const desktopVal = desktopAttrs[key]
      expect(desktopVal, `desktop missing engine attribute ${key}`).toBeDefined()
      if (key === 'nested' || key === 'list') {
        expect(desktopVal.stringValue, `${key} must be a stringValue on both sides`).toBeTypeOf('string')
        expect(JSON.parse(desktopVal.stringValue!)).toEqual(JSON.parse(engineVal.stringValue!))
      } else {
        expect(desktopVal).toEqual(engineVal)
      }
    }
  })

  it('otlpAttrValFromAny follows the shared native-scalar convention', () => {
    expect(otlpAttrValFromAny('s')).toEqual({ stringValue: 's' })
    expect(otlpAttrValFromAny(true)).toEqual({ boolValue: true })
    expect(otlpAttrValFromAny(7)).toEqual({ intValue: '7' })
    expect(otlpAttrValFromAny(7.0)).toEqual({ intValue: '7' })
    expect(otlpAttrValFromAny(1.5)).toEqual({ doubleValue: 1.5 })
    expect(otlpAttrValFromAny(null)).toEqual({ stringValue: '' })
    expect(otlpAttrValFromAny(undefined)).toEqual({ stringValue: '' })
    expect(JSON.parse(otlpAttrValFromAny({ x: 1 }).stringValue!)).toEqual({ x: 1 })
  })
})

// ---------------------------------------------------------------------------
// Regression: missing-field records must not wedge the spool drain
// ---------------------------------------------------------------------------

/**
 * These tests pin the fix for the production egress outage: the tailer ships
 * ~/.ion/telemetry.jsonl verbatim, and those cost-telemetry EVENT records
 * ({name, ts, schema, component, event_id, payload}) carry no `level` and no
 * `msg`. Before the fix, buildOtlpPayload called `r.level.toUpperCase()` on
 * every record; a telemetry record's undefined `level` threw
 * "Cannot read properties of undefined (reading 'toUpperCase')", which aborted
 * the whole `records.map()`, set spoolFailed, and left a 23 MB spool undrained.
 *
 * The contract these tests pin:
 *   1. A record missing `level` maps to the INFO default instead of throwing.
 *   2. buildOtlpPayload never throws on such a record — the batch is built and
 *      the record ships (severityText "INFO", severityNumber 9, empty body).
 *   3. One mis-shaped record in a batch does not abort the other records: the
 *      whole batch still builds and every mappable record is present.
 *
 * Revert the normalization in buildOtlpPayload / otlpSeverityNumber and these
 * go red with the exact production error string.
 */
describe('OTLP missing-field resilience (spool-drain regression)', () => {
  // A verbatim cost-telemetry event line as it lands in telemetry.jsonl and is
  // shipped by the tailer: no `level`, no `msg`. Cast through unknown because
  // the shape deliberately violates the operational EgressRecord contract —
  // that mismatch is exactly the production condition.
  function telemetryEventRecord(): EgressRecord {
    return {
      name: 'dispatch.agent',
      ts: '2026-07-08T01:00:04.615215Z',
      schema: 3,
      component: 'engine',
      install_id: '5a435113-060b-4b0c-a5c9-1184ccd709a5',
      event_id: '9bcfdf62c9f04d08',
      payload: { agent: 'dev-lead', cost_usd: 2.0167875 },
    } as unknown as EgressRecord
  }

  it('normalizeSeverityText maps a missing/empty/non-string level to INFO', () => {
    expect(normalizeSeverityText(undefined)).toBe('INFO')
    expect(normalizeSeverityText('')).toBe('INFO')
    expect(normalizeSeverityText('   ')).toBe('INFO')
    expect(normalizeSeverityText(3)).toBe('INFO')
    // A present level is still honored and uppercased.
    expect(normalizeSeverityText('warn')).toBe('WARN')
    expect(normalizeSeverityText('ERROR')).toBe('ERROR')
  })

  it('otlpSeverityNumber does not throw on an undefined level (defaults to 9)', () => {
    expect(() => otlpSeverityNumber(undefined)).not.toThrow()
    expect(otlpSeverityNumber(undefined)).toBe(9)
  })

  it('buildOtlpPayload ships a telemetry record missing level/msg instead of throwing', () => {
    const rec = telemetryEventRecord()

    let payload!: ReturnType<typeof buildOtlpPayload>
    expect(() => { payload = buildOtlpPayload([rec], 'ion-desktop') }).not.toThrow()

    const logRecords = payload.resourceLogs[0].scopeLogs[0].logRecords
    // The record was NOT dropped — it drained.
    expect(logRecords).toHaveLength(1)
    const lr = logRecords[0]
    // Missing level → INFO default (parity with the engine exporter's switch default).
    expect(lr.severityText).toBe('INFO')
    expect(lr.severityNumber).toBe(9)
    // Telemetry event body is the verbatim event JSON (NOT empty) so a
    // dashboard's `| json | unwrap payload_*` can flatten the payload.
    expect(lr.body.stringValue.length).toBeGreaterThan(0)
    expect(JSON.parse(lr.body.stringValue)).toMatchObject({
      name: 'dispatch.agent',
      payload: { agent: 'dev-lead', cost_usd: 2.0167875 },
    })
    // Structured context flattens to attributes: component preserved AND the
    // telemetry data (kind, service) that the operational mapper dropped.
    const attrs = attrMap(lr.attributes)
    expect(attrs.component).toEqual({ stringValue: 'engine' })
    expect(attrs.kind).toEqual({ stringValue: 'dispatch.agent' })
    expect(attrs.service).toEqual({ stringValue: 'ion-telemetry' })
  })

  it('one malformed record does not abort the batch — the good records still ship', () => {
    const good = canonicalRecord()
    const telemetry = telemetryEventRecord()

    const payload = buildOtlpPayload([good, telemetry, good], 'ion-desktop')
    const logRecords = payload.resourceLogs[0].scopeLogs[0].logRecords

    // All three records built — the flush completes shipping the whole batch,
    // not zero rows. This is the anti-wedge guarantee.
    expect(logRecords).toHaveLength(3)
    // The two canonical records keep their real severity. Body is full JSONL.
    expect(logRecords[0].severityText).toBe('INFO')
    expect(JSON.parse(logRecords[0].body.stringValue).msg).toBe('session started')
    expect(logRecords[2].severityText).toBe('INFO')
    // The telemetry record in the middle drained with the default severity.
    expect(logRecords[1].severityText).toBe('INFO')
    expect(logRecords[1].severityNumber).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// Telemetry EVENT records survive OTLP with full fidelity (the strip fix)
// ---------------------------------------------------------------------------

/**
 * These tests pin the root-cause fix for the empty prod Cost / Runs / Extensions
 * dashboards: before the fix, a telemetry event serialized to OTLP carried a
 * single `component` attribute — the operational-log mapper (otlpAttrsFromRecord)
 * reads only msg/level/tag/correlation-ids/fields, none of which a telemetry
 * event ({name, payload:{...}, context:{...}}) populates. Every cost, kind,
 * token, and attribution field was silently discarded before the bytes left the
 * desktop, so no downstream Alloy/Loki/dashboard change could recover them.
 *
 * The contract these tests pin:
 *   1. A telemetry event is recognized as such (isTelemetryEventRecord).
 *   2. name → kind; payload.* and context.* → attributes, with the EXACT field
 *      names the file-tail pipeline (docs/observability/alloy-config.alloy) uses,
 *      so the SAME dashboards render against both ingestion paths.
 *   3. The OTLP body is the verbatim event JSON, so `| json | unwrap payload_*`
 *      resolves identically to the file-tail raw line.
 *   4. A loki.attribute.labels hint promotes service+kind to stream labels so
 *      `{service="ion-telemetry", kind="run.complete"}` selects the stream.
 *
 * Revert the telemetry branch in buildOtlpPayload (route the event through
 * otlpAttrsFromRecord) and assertions 2-4 go red: the payload/kind/context
 * attributes vanish and the body becomes empty — the exact production strip.
 */
describe('telemetry event OTLP fidelity (dashboard strip fix)', () => {
  // A REAL run.complete event line as it lands in telemetry.jsonl and is
  // shipped verbatim by the tailer (shape from live Loki sample).
  function runCompleteRecord(): EgressRecord {
    return {
      name: 'run.complete',
      ts: '2026-07-09T12:06:59.845721Z',
      schema: 3,
      component: 'engine',
      install_id: '5a435113-060b-4b0c-a5c9-1184ccd709a5',
      host: 'jolteon',
      version: 'dev',
      event_id: '86693acc4aa9560e',
      payload: {
        aggregate_cost_usd: 766.8477343999997,
        cache_creation_input_tokens: 176086,
        cache_read_input_tokens: 348822,
        dispatch_depth: 0,
        duration_ms: 31341,
        input_tokens: 6,
        model: 'claude-opus-4-8',
        num_turns: 3,
        output_tokens: 1758,
        run_cost_usd: 1.3189285000000002,
      },
      context: {
        conversation_id: '1783339918596-0a78dd0c12ca',
        extension: 'ion-dev',
        extension_version: '0.2.0',
        session_id: '230dad54-0960-4c08-ace2-35f75a8f23be',
      },
    } as unknown as EgressRecord
  }

  it('recognizes telemetry events and does not misclassify operational records', () => {
    expect(isTelemetryEventRecord(runCompleteRecord())).toBe(true)
    expect(isTelemetryEventRecord(canonicalRecord())).toBe(false)
  })

  it('maps name→kind and payload/context to file-tail-named attributes', () => {
    const attrs = attrMap(otlpAttrsFromTelemetryEvent(runCompleteRecord()))

    // kind + service are the stream-label discriminators the dashboards select.
    expect(attrs.kind).toEqual({ stringValue: 'run.complete' })
    expect(attrs.service).toEqual({ stringValue: 'ion-telemetry' })
    expect(attrs.component).toEqual({ stringValue: 'engine' })

    // payload.* with the file-tail rename map (aggregate_cost_usd→agg_cost_usd,
    // cache_*_input_tokens→cache_*_tokens). Native typing: int→intValue,
    // non-integer→doubleValue.
    expect(attrs.run_cost_usd).toEqual({ doubleValue: 1.3189285000000002 })
    expect(attrs.agg_cost_usd).toEqual({ doubleValue: 766.8477343999997 })
    expect(attrs.model).toEqual({ stringValue: 'claude-opus-4-8' })
    expect(attrs.num_turns).toEqual({ intValue: '3' })
    expect(attrs.input_tokens).toEqual({ intValue: '6' })
    expect(attrs.output_tokens).toEqual({ intValue: '1758' })
    expect(attrs.cache_read_tokens).toEqual({ intValue: '348822' })
    expect(attrs.cache_creation_tokens).toEqual({ intValue: '176086' })
    expect(attrs.duration_ms).toEqual({ intValue: '31341' })
    // dispatch_depth is a present zero — it must still be emitted.
    expect(attrs.dispatch_depth).toEqual({ intValue: '0' })

    // context.* attribution.
    expect(attrs.context_extension).toEqual({ stringValue: 'ion-dev' })
    expect(attrs.context_extension_version).toEqual({ stringValue: '0.2.0' })
    expect(attrs.context_conversation_id).toEqual({ stringValue: '1783339918596-0a78dd0c12ca' })
    expect(attrs.context_session_id).toEqual({ stringValue: '230dad54-0960-4c08-ace2-35f75a8f23be' })

    // top-level envelope.
    expect(attrs.schema_version).toEqual({ intValue: '3' })
    expect(attrs.install_id).toEqual({ stringValue: '5a435113-060b-4b0c-a5c9-1184ccd709a5' })
    expect(attrs.engine_version).toEqual({ stringValue: 'dev' })
  })

  it('omits absent payload/context fields (no empty-string noise)', () => {
    // llm.call has no run_cost_usd / num_turns / tokens.
    const llmCall = {
      name: 'llm.call',
      ts: '2026-07-09T12:06:59.240797Z',
      schema: 3,
      component: 'engine',
      payload: { duration_ms: 5820, model: 'claude-opus-4-8', stop_reason: 'end_turn' },
      context: { session_id: 's1' },
    } as unknown as EgressRecord
    const attrs = attrMap(otlpAttrsFromTelemetryEvent(llmCall))
    expect(attrs.kind).toEqual({ stringValue: 'llm.call' })
    expect(attrs.duration_ms).toEqual({ intValue: '5820' })
    expect(attrs.stop_reason).toEqual({ stringValue: 'end_turn' })
    // Absent fields are not emitted at all.
    for (const absent of ['run_cost_usd', 'num_turns', 'input_tokens', 'context_extension']) {
      expect(attrs[absent], `${absent} must be omitted when absent`).toBeUndefined()
    }
  })

  it('buildOtlpPayload: body is verbatim event JSON with payload.run_cost_usd intact', () => {
    const payload = buildOtlpPayload([runCompleteRecord()], 'ion-desktop')
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0]

    // Body is the verbatim event JSON — `| json | unwrap payload_run_cost_usd`
    // flattens payload.run_cost_usd → payload_run_cost_usd on the dashboard.
    const parsed = JSON.parse(lr.body.stringValue)
    expect(parsed.name).toBe('run.complete')
    expect(parsed.payload.run_cost_usd).toBe(1.3189285000000002)
    expect(parsed.payload.model).toBe('claude-opus-4-8')

    // The label-promotion hint is present and names service+kind (+component)
    // so otelcol.exporter.loki promotes them to Loki stream labels.
    const attrs = attrMap(lr.attributes)
    expect(attrs['loki.attribute.labels']).toBeDefined()
    const promoted = attrs['loki.attribute.labels'].stringValue!.split(',').map((s) => s.trim())
    expect(promoted).toContain('service')
    expect(promoted).toContain('kind')
  })

  it('telemetryEventBody reproduces the ingestible line and never throws', () => {
    const body = telemetryEventBody(runCompleteRecord())
    expect(() => JSON.parse(body)).not.toThrow()
    expect(JSON.parse(body).payload.run_cost_usd).toBe(1.3189285000000002)
  })

  it('operational records still carry the component/tag promotion hint', () => {
    const payload = buildOtlpPayload([canonicalRecord()], 'ion-desktop')
    const attrs = attrMap(payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes)
    // Operational records are unchanged EXCEPT for the promotion hint that makes
    // "Log volume by component" / "Extension activity" resolve over OTLP.
    expect(attrs['loki.attribute.labels']).toBeDefined()
    const promoted = attrs['loki.attribute.labels'].stringValue!.split(',').map((s) => s.trim())
    expect(promoted).toContain('component')
    expect(promoted).toContain('tag')
    // The operational payload is intact (body is the full JSONL, fields flattened as attrs).
    expect(JSON.parse(payload.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue).msg).toBe('session started')
    expect(attrs.run_id).toEqual({ stringValue: 'run-xyz' })
  })
})
