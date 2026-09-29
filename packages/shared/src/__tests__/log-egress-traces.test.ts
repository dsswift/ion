/**
 * log-egress-traces — the TypeScript span exporter mirrors the engine's
 * (engine/internal/utils/log_egress_traces_test.go carries the same cases):
 * both span record shapes are recognized, anything else is not, and the otel
 * target ships a batch's spans to /v1/traces after its logs, with the same
 * headers, without failing the batch when the span export fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EgressRecord } from '../log-egress-types'
import { flushToOtel } from '../log-egress-otel'
import {
  OTLP_SPAN_KIND_SERVER,
  OTLP_STATUS_ERROR,
  rfc3339ToUnixNano,
  spanFromRecord,
  type OtlpTracesExportRequest,
} from '../log-egress-traces'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'
const PARENT = '1111222233334444'

describe('spanFromRecord', () => {
  it('recognizes a telemetry span event', () => {
    const rec: EgressRecord = {
      ts: '2026-09-23T10:00:01.5Z', level: '', msg: '', component: 'engine',
      name: 'llm.call', trace_id: TRACE,
      payload: { span_id: SPAN, duration_ms: 1500, model: 'm', error: 'boom' },
      context: { parent_span_id: PARENT, run_id: 'r1' },
    }
    const got = spanFromRecord(rec)
    expect(got).not.toBeNull()
    const s = got!.span
    expect(got!.service).toBe('ion-engine')
    expect([s.name, s.traceId, s.spanId, s.parentSpanId]).toEqual(['llm.call', TRACE, SPAN, PARENT])
    const end = rfc3339ToUnixNano(rec.ts)!
    expect(s.endTimeUnixNano).toBe(end.toString())
    expect(s.startTimeUnixNano).toBe((end - 1_500_000_000n).toString())
    expect(s.status).toEqual({ code: OTLP_STATUS_ERROR, message: 'boom' })
    const keys = s.attributes.map((a) => a.key)
    expect(keys).toContain('model')
    expect(keys).toContain('run_id')
    expect(keys).not.toContain('span_id')
    expect(keys).not.toContain('duration_ms')
  })

  it('recognizes a span log line', () => {
    const rec: EgressRecord = {
      ts: '2026-09-23T10:00:01Z', level: 'INFO', msg: 'prompt.send', component: 'server', tag: 'span',
      trace_id: TRACE, conversation_id: 'c1',
      fields: { span_id: SPAN, parent_span_id: PARENT, duration_ms: 12, span_kind: 'server' },
    }
    const got = spanFromRecord(rec)
    expect(got?.service).toBe('ion-server')
    expect(got?.span.kind).toBe(OTLP_SPAN_KIND_SERVER)
    expect(got?.span.parentSpanId).toBe(PARENT)
    expect(got?.span.attributes).toContainEqual({ key: 'conversation_id', value: { stringValue: 'c1' } })
  })

  it('keeps every fractional digit of the end time', () => {
    expect(rfc3339ToUnixNano('2026-09-23T10:00:01.123456789Z')).toBe(1790157601123456789n)
    expect(rfc3339ToUnixNano('2026-09-23T12:00:01+02:00')).toBe(1790157601000000000n)
    expect(rfc3339ToUnixNano('yesterday')).toBeNull()
  })

  it('rejects records that are not complete spans', () => {
    const cases: Record<string, EgressRecord> = {
      'plain log line': { ts: '2026-09-23T10:00:01Z', level: 'INFO', msg: 'hello', component: 'engine', tag: 'session', trace_id: TRACE },
      'telemetry point': { ts: '2026-09-23T10:00:01Z', level: '', msg: '', component: 'engine', name: 'run.complete', trace_id: TRACE, payload: { duration_ms: 5 } },
      'missing trace': { ts: '2026-09-23T10:00:01Z', level: '', msg: '', component: 'engine', name: 'llm.call', payload: { span_id: SPAN, duration_ms: 5 } },
      'missing duration': { ts: '2026-09-23T10:00:01Z', level: '', msg: '', component: 'engine', name: 'llm.call', trace_id: TRACE, payload: { span_id: SPAN } },
      'span tag, bad id': { ts: '2026-09-23T10:00:01Z', level: 'INFO', msg: 'x', component: 'server', tag: 'span', trace_id: TRACE, fields: { span_id: 'nope', duration_ms: 1 } },
      'unparseable ts': { ts: 'yesterday', level: '', msg: '', component: 'engine', name: 'llm.call', trace_id: TRACE, payload: { span_id: SPAN, duration_ms: 5 } },
    }
    for (const [name, rec] of Object.entries(cases)) {
      expect(spanFromRecord(rec), name).toBeNull()
    }
  })
})

describe('flushToOtel spans', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const records: EgressRecord[] = [
    { ts: '2026-09-23T10:00:01Z', level: 'INFO', msg: 'hello', component: 'engine', tag: 'session' },
    { ts: '2026-09-23T10:00:01Z', level: '', msg: '', component: 'engine', name: 'tool.execute', trace_id: TRACE, payload: { span_id: SPAN, duration_ms: 3 } },
  ]

  it('ships spans to /v1/traces after the logs, with the same headers', async () => {
    const calls: Array<{ url: string; auth: string; body: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      calls.push({ url, auth: headers.Authorization, body: String(init.body) })
      return new Response('', { status: 200 })
    }))
    await flushToOtel(records, { endpoint: 'http://collector', headers: { Authorization: 'Bearer t' } }, {})
    expect(calls.map((c) => `${c.url} ${c.auth}`)).toEqual([
      'http://collector/v1/logs Bearer t',
      'http://collector/v1/traces Bearer t',
    ])
    const traces = JSON.parse(calls[1].body) as OtlpTracesExportRequest
    expect(traces.resourceSpans).toHaveLength(1)
    expect(traces.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1)
  })

  it('does not fail the batch when the span export is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('', { status: url.endsWith('/v1/traces') ? 502 : 200 })))
    await expect(flushToOtel(records.slice(1), { endpoint: 'http://collector' }, {})).resolves.toBeUndefined()
  })

  it('sends nothing to /v1/traces for a batch with no spans', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await flushToOtel(records.slice(0, 1), { endpoint: 'http://collector' }, {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
