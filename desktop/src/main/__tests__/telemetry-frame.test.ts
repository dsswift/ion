import { describe, expect, it } from 'vitest'
import type { EgressRecord } from '../log-egress'
import {
  decodeTelemetryLine,
  expandTelemetryFrame,
  expandTelemetryRecord,
  parseTelemetryFrame,
  TELEMETRY_FRAME_RECORD,
  TELEMETRY_FRAME_VERSION,
  TelemetryFrameRecordError,
  TelemetryFrameSchemaError,
  TelemetryFrameTableReferenceError,
  TelemetryFrameValidationError,
  type TelemetryFrame,
} from '../telemetry-frame'

function frame(): TelemetryFrame {
  return {
    record: TELEMETRY_FRAME_RECORD,
    schema: TELEMETRY_FRAME_VERSION,
    identities: [{
      component: 'engine',
      install_id: 'install-1',
      host: 'host-1',
      version: 'v1.2.3',
      user: 'user@example.com',
    }],
    contexts: [{
      context: { conversation_id: 'conversation-1', session_id: 'session-1' },
      trace_id: 'trace-1',
    }],
    events: [
      {
        i: 0,
        c: 0,
        name: 'run.complete',
        ts: '2026-08-25T12:00:00.000Z',
        event_id: 'event-1',
        payload: { run_cost_usd: 0.01, input_tokens: 42 },
      },
      {
        i: 0,
        name: 'tool.execute',
        ts: '2026-08-25T12:00:01.000Z',
        payload: { tool: 'Read' },
      },
    ],
  }
}

describe('telemetry frame', () => {
  it('expands v4 interned identity and context tables into egress records', () => {
    const records = expandTelemetryFrame(frame())

    expect(records).toEqual([
      {
        name: 'run.complete',
        ts: '2026-08-25T12:00:00.000Z',
        schema: 4,
        component: 'engine',
        install_id: 'install-1',
        host: 'host-1',
        version: 'v1.2.3',
        user: 'user@example.com',
        event_id: 'event-1',
        context: { conversation_id: 'conversation-1', session_id: 'session-1' },
        trace_id: 'trace-1',
        payload: { run_cost_usd: 0.01, input_tokens: 42 },
      },
      {
        name: 'tool.execute',
        ts: '2026-08-25T12:00:01.000Z',
        schema: 4,
        component: 'engine',
        install_id: 'install-1',
        host: 'host-1',
        version: 'v1.2.3',
        user: 'user@example.com',
        payload: { tool: 'Read' },
      },
    ])
  })

  it('preserves a legacy telemetry event by reference', () => {
    const legacy = {
      name: 'run.complete',
      ts: '2026-08-25T12:00:00.000Z',
      schema: 3,
      level: 'INFO',
      msg: 'run complete',
      component: 'engine',
      payload: { run_cost_usd: 0.01 },
    } as EgressRecord

    expect(expandTelemetryRecord(legacy)).toEqual([legacy])
    expect(expandTelemetryRecord(legacy)[0]).toBe(legacy)
  })

  it('decodes a serialized v4 frame deterministically', () => {
    const line = JSON.stringify(frame())

    expect(decodeTelemetryLine(line)).toEqual(expandTelemetryFrame(frame()))
  })

  it('rejects invalid record and schema values with typed errors', () => {
    expect(() => parseTelemetryFrame({ ...frame(), record: 'wrong.record' }))
      .toThrow(TelemetryFrameRecordError)
    expect(() => parseTelemetryFrame({ ...frame(), schema: 3 }))
      .toThrow(TelemetryFrameSchemaError)
  })

  it('rejects missing required values and invalid table references', () => {
    expect(() => parseTelemetryFrame({ ...frame(), events: [{ ...frame().events[0], payload: null }] }))
      .toThrow(TelemetryFrameValidationError)
    expect(() => expandTelemetryFrame({ ...frame(), events: [{ ...frame().events[0], i: 1 }] }))
      .toThrow(TelemetryFrameTableReferenceError)
    expect(() => expandTelemetryFrame({ ...frame(), events: [{ ...frame().events[0], c: 1 }] }))
      .toThrow(TelemetryFrameTableReferenceError)
  })

  it('rejects a non-frame schema v4 record', () => {
    const malformed = {
      name: 'run.complete',
      ts: '2026-08-25T12:00:00.000Z',
      schema: 4,
      level: 'INFO',
      msg: 'run complete',
      component: 'engine',
      payload: {},
    } as EgressRecord

    expect(() => expandTelemetryRecord(malformed)).toThrow(TelemetryFrameSchemaError)
  })
})
