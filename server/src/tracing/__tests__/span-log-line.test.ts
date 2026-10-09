/**
 * A trace_id a caller states is a top-level key on the server's log line and
 * on the record it ships, and a finished span becomes the canonical span log
 * line (docs/observability/log-schema.md § Spans) that the span exporters
 * recognize.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EgressRecord } from '@ion/shared/log-egress'

const shipped = vi.hoisted(() => [] as EgressRecord[])
vi.mock('@ion/shared/log-egress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ion/shared/log-egress')>()),
  shipToEgress: (r: EgressRecord) => { shipped.push(r) },
}))

import { flushLogs, log, _resetForTest as resetLoggerForTest } from '../../logger'
import { writeServerSpan } from '../prompt-span'
import { startSpan } from '@ion/shared/trace-context'
import { spanFromRecord } from '@ion/shared/log-egress-traces'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const CLIENT_SPAN = '00f067aa0ba902b7'

let dir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-log-trace-'))
  process.env.ION_DATA_DIR = dir
  resetLoggerForTest()
  shipped.length = 0
})

afterEach(() => {
  resetLoggerForTest()
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

function lastLine(): Record<string, unknown> {
  flushLogs()
  return JSON.parse(readFileSync(join(dir, 'server.jsonl'), 'utf-8').trim().split('\n').pop() ?? '{}')
}

describe('trace_id on server log lines', () => {
  it('lifts a trace_id field to the top level of the line and the shipped record', () => {
    log('main', 'pipeline: submit prompt', { tab_id: 't1', trace_id: TRACE })
    const line = lastLine()
    expect(line.trace_id).toBe(TRACE)
    expect(line.fields).not.toHaveProperty('trace_id')
    expect(shipped.at(-1)?.trace_id).toBe(TRACE)
    expect(shipped.at(-1)?.fields).not.toHaveProperty('trace_id')
  })

  it('leaves trace_id off a line that states none', () => {
    log('main', 'no trace here', { tab_id: 't1' })
    expect(lastLine()).not.toHaveProperty('trace_id')
  })
})

describe('server span log line', () => {
  it('writes the canonical span line, and the exporter reads it back as the same span', () => {
    const span = startSpan('action.handle', {
      writer: writeServerSpan,
      kind: 'server',
      parent: `00-${TRACE}-${CLIENT_SPAN}-01`,
      attributes: { tab_id: 't1', conversation_id: '1780093348767-c1c03e998388' },
    })
    span.end({ accepted: true })

    const line = lastLine()
    expect(line).toMatchObject({
      level: 'INFO', component: 'server', tag: 'span', msg: 'action.handle',
      trace_id: TRACE, conversation_id: '1780093348767-c1c03e998388',
    })
    const fields = line.fields as Record<string, unknown>
    expect(fields).toMatchObject({ span_id: span.spanId, parent_span_id: CLIENT_SPAN, span_kind: 'server', tab_id: 't1', accepted: true })
    expect(typeof fields.duration_ms).toBe('number')
    // Lifted ids are not repeated in fields, so the exported span has one attribute each.
    expect(fields).not.toHaveProperty('trace_id')
    expect(fields).not.toHaveProperty('conversation_id')

    const exported = spanFromRecord(shipped.at(-1)!)
    expect(exported?.service).toBe('ion-server')
    expect(exported?.span).toMatchObject({ traceId: TRACE, spanId: span.spanId, parentSpanId: CLIENT_SPAN, name: 'action.handle' })
    expect(exported?.span.attributes.filter((a) => a.key === 'conversation_id')).toHaveLength(1)
  })

  it('writes a failed span at WARN with its error', () => {
    startSpan('action.handle', { writer: writeServerSpan, kind: 'server' }).end(undefined, 'engine down')
    const line = lastLine()
    expect(line).toMatchObject({ level: 'WARN', tag: 'span' })
    expect((line.fields as Record<string, unknown>).error).toBe('engine down')
  })
})
