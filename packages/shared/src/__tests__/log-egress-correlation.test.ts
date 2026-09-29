import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildOtlpPayload, type OtlpLogAttr } from '../log-egress-otel'
import { buildTracesExport, OTLP_SPAN_KIND_CLIENT, OTLP_SPAN_KIND_SERVER } from '../log-egress-traces'
import {
  ION_SERVICE_NAMESPACE,
  resetHostInstallIdForTest,
  resourceHostName,
  resourceServiceName,
  setEgressServiceVersion,
} from '../log-egress-resource'
import type { EgressRecord } from '../log-egress-types'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'
const PARENT = '1111222233334444'
const TS = '2026-09-23T10:00:01Z'

function attrs(list: OtlpLogAttr[]): Record<string, string | undefined> {
  return Object.fromEntries(list.map((a) => [a.key, a.value.stringValue]))
}

function spanLine(component: string, name: string, fields: Record<string, unknown>): EgressRecord {
  return { ts: TS, level: 'INFO', msg: name, component, tag: 'span', trace_id: TRACE, fields: { duration_ms: 1, ...fields } }
}

beforeEach(() => {
  resetHostInstallIdForTest('install-1')
  setEgressServiceVersion('9.9.9')
})
afterEach(() => {
  resetHostInstallIdForTest()
  setEgressServiceVersion('')
})

describe('OTLP log record trace correlation', () => {
  it('sets traceId/spanId as LogRecord fields and repeats neither as an attribute', () => {
    const records: EgressRecord[] = [
      { ts: TS, level: 'INFO', msg: 'run started', component: 'engine', tag: 'session', trace_id: TRACE },
      spanLine('server', 'prompt.handle', { span_id: SPAN, parent_span_id: PARENT, span_kind: 'server' }),
      { ts: TS, level: '', msg: '', component: 'engine', name: 'tool.execute', trace_id: TRACE, payload: { tool: 'Bash' }, context: { parent_span_id: PARENT } },
      { ts: TS, level: 'INFO', msg: 'no trace', component: 'engine', tag: 'session' },
      { ts: TS, level: 'INFO', msg: 'bad trace', component: 'engine', tag: 'session', trace_id: TRACE.toUpperCase() },
    ]
    const payload = buildOtlpPayload(records, 'ion-server')
    const byMsg = new Map<string, Record<string, unknown>>()
    for (const rl of payload.resourceLogs) {
      for (const lr of rl.scopeLogs[0].logRecords) {
        const body = JSON.parse(lr.body.stringValue) as { msg?: string; name?: string }
        byMsg.set(body.msg || body.name || '', lr as unknown as Record<string, unknown>)
      }
    }
    const want: Record<string, [string?, string?]> = {
      'run started': [TRACE],
      'prompt.handle': [TRACE, SPAN],
      'tool.execute': [TRACE, PARENT],
      'no trace': [],
      'bad trace': [],
    }
    for (const [msg, [traceId, spanId]] of Object.entries(want)) {
      const lr = byMsg.get(msg)
      expect(lr, msg).toBeDefined()
      expect(lr?.traceId, msg).toBe(traceId)
      expect(lr?.spanId, msg).toBe(spanId)
      expect(attrs(lr?.attributes as OtlpLogAttr[]).trace_id, msg).toBeUndefined()
      expect(attrs(lr?.attributes as OtlpLogAttr[]).span_id, msg).toBeUndefined()
    }
    // Wire key order matches the engine exporter.
    expect(Object.keys(byMsg.get('prompt.handle') ?? {})).toEqual(
      ['timeUnixNano', 'severityNumber', 'severityText', 'traceId', 'spanId', 'body', 'attributes'],
    )
  })
})

describe('OTLP resource per source', () => {
  it('gives logs and spans from one source one resource, and iOS lines the device identity', () => {
    const records: EgressRecord[] = [
      { ts: TS, level: 'INFO', msg: 'hello', component: 'engine', tag: 'session' },
      { ts: TS, level: 'INFO', msg: 'hello', component: 'server', tag: 'prompt' },
      spanLine('server', 's', { span_id: SPAN }),
      spanLine('ios', 's', { span_id: SPAN, device_id: 'DEV-1', app_version: '3.2.1' }),
    ]
    const configured = { 'deployment.environment.name': 'prod', 'service.name': 'ignored' }
    const logs = buildOtlpPayload(records, 'ion-server', configured)
    const traces = buildTracesExport(records, configured)
    const logRes = new Map(logs.resourceLogs.map((rl) => [resourceServiceName(rl.resource.attributes), attrs(rl.resource.attributes)]))
    const spanRes = new Map((traces?.request.resourceSpans ?? []).map((rs) => [resourceServiceName(rs.resource.attributes), attrs(rs.resource.attributes)]))

    expect([...logRes.keys()].sort()).toEqual(['ion-engine', 'ion-ios', 'ion-server'])
    expect(spanRes.get('ion-server')).toEqual(logRes.get('ion-server'))
    expect(logRes.get('ion-server')).toEqual({
      'deployment.environment.name': 'prod',
      'host.name': resourceHostName(),
      'service.instance.id': 'install-1',
      'service.name': 'ion-server',
      'service.namespace': ION_SERVICE_NAMESPACE,
      'service.version': '9.9.9',
    })
    expect(spanRes.get('ion-ios')).toEqual({
      'deployment.environment.name': 'prod',
      'service.instance.id': 'DEV-1',
      'service.name': 'ion-ios',
      'service.namespace': ION_SERVICE_NAMESPACE,
      'service.version': '3.2.1',
    })
  })
})

describe('span kind per hop', () => {
  it('makes each CLIENT span the parent of the SERVER span in the next service', () => {
    const ids = { send: 'a000000000000001', handle: 'a000000000000002', call: 'a000000000000003', run: 'a000000000000004' }
    const records: EgressRecord[] = [
      spanLine('web', 'prompt.send', { span_id: ids.send, span_kind: 'client' }),
      spanLine('server', 'prompt.handle', { span_id: ids.handle, parent_span_id: ids.send, span_kind: 'server' }),
      spanLine('server', 'engine.send_prompt', { span_id: ids.call, parent_span_id: ids.handle, span_kind: 'client' }),
      {
        ts: TS, level: '', msg: '', component: 'engine', name: 'run.execute', trace_id: TRACE,
        payload: { span_id: ids.run, duration_ms: 1, span_kind: 'server' }, context: { parent_span_id: ids.call },
      },
    ]
    const built = buildTracesExport(records)
    const placed = new Map<string, { service: string; kind: number; parent?: string }>()
    for (const rs of built?.request.resourceSpans ?? []) {
      for (const s of rs.scopeSpans[0].spans) {
        placed.set(s.spanId, { service: resourceServiceName(rs.resource.attributes), kind: s.kind, parent: s.parentSpanId })
      }
    }
    expect(placed.get(ids.send)?.kind).toBe(OTLP_SPAN_KIND_CLIENT)
    expect(placed.get(ids.handle)?.kind).toBe(OTLP_SPAN_KIND_SERVER)
    expect(placed.get(ids.call)?.kind).toBe(OTLP_SPAN_KIND_CLIENT)
    expect(placed.get(ids.run)?.kind).toBe(OTLP_SPAN_KIND_SERVER)
    for (const [client, server] of [[ids.send, ids.handle], [ids.call, ids.run]]) {
      expect(placed.get(server)?.parent).toBe(client)
      expect(placed.get(server)?.service).not.toBe(placed.get(client)?.service)
    }
  })
})
