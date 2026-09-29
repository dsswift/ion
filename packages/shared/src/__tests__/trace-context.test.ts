/**
 * trace-context — W3C traceparent parsing must accept and refuse exactly what
 * the engine does (engine/internal/utils/traceparent_test.go carries the same
 * table), and a span must join its parent's trace and hand one record to its
 * writer.
 */
import { describe, it, expect } from 'vitest'
import {
  formatTraceparent,
  isValidSpanId,
  isValidTraceId,
  newSpanId,
  newTraceId,
  parseTraceparent,
  spanLogFields,
  startSpan,
  type SpanRecord,
} from '../trace-context'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'

describe('parseTraceparent', () => {
  const cases: Array<[string, string, boolean]> = [
    ['valid', `00-${TRACE}-${SPAN}-01`, true],
    ['valid unsampled', `00-${TRACE}-${SPAN}-00`, true],
    ['surrounding space', `  00-${TRACE}-${SPAN}-01 `, true],
    ['empty', '', false],
    ['unknown version', `01-${TRACE}-${SPAN}-01`, false],
    ['zero trace', `00-00000000000000000000000000000000-${SPAN}-01`, false],
    ['zero span', `00-${TRACE}-0000000000000000-01`, false],
    ['uppercase', `00-4BF92F3577B34DA6A3CE929D0E0E4736-${SPAN}-01`, false],
    ['short span', `00-${TRACE}-00f067aa-01`, false],
    ['missing flags', `00-${TRACE}-${SPAN}`, false],
  ]
  for (const [name, value, ok] of cases) {
    it(name, () => {
      const got = parseTraceparent(value)
      if (!ok) {
        expect(got).toBeNull()
        return
      }
      expect(got).toEqual({ traceId: TRACE, spanId: SPAN })
    })
  }

  it('refuses a non-string', () => {
    expect(parseTraceparent(undefined)).toBeNull()
    expect(parseTraceparent(42)).toBeNull()
  })
})

describe('ids', () => {
  it('mints valid trace and span ids that round trip through a traceparent', () => {
    const trace = newTraceId()
    const span = newSpanId()
    expect(isValidTraceId(trace)).toBe(true)
    expect(isValidSpanId(span)).toBe(true)
    expect(parseTraceparent(formatTraceparent(trace, span))).toEqual({ traceId: trace, spanId: span })
  })

  it('formats a sampled version-00 value', () => {
    expect(formatTraceparent(TRACE, SPAN)).toBe(`00-${TRACE}-${SPAN}-01`)
  })
})

describe('startSpan', () => {
  function clock(...times: number[]): () => number {
    return () => times.shift() ?? 0
  }

  it('joins a valid parent and hands one record to the writer', () => {
    const written: SpanRecord[] = []
    const span = startSpan('prompt.handle', {
      writer: (r) => written.push(r),
      parent: `00-${TRACE}-${SPAN}-01`,
      kind: 'server',
      attributes: { tab_id: 't1' },
      now: clock(1000, 1012),
    })
    expect(span.joined).toBe(true)
    expect(span.traceId).toBe(TRACE)
    expect(span.parentSpanId).toBe(SPAN)
    expect(parseTraceparent(span.traceparent)).toEqual({ traceId: TRACE, spanId: span.spanId })

    span.end({ accepted: true })
    span.end({ accepted: false }, 'late')
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      name: 'prompt.handle', traceId: TRACE, parentSpanId: SPAN, kind: 'server',
      startMs: 1000, endMs: 1012, durationMs: 12, attributes: { tab_id: 't1', accepted: true },
    })
    expect(written[0].error).toBeUndefined()
  })

  it('starts a new root for a missing or invalid parent', () => {
    for (const parent of [undefined, 'garbage', { traceId: 'x', spanId: SPAN }]) {
      const span = startSpan('prompt.send', { writer: () => {}, parent })
      expect(span.joined).toBe(false)
      expect(span.parentSpanId).toBeUndefined()
      expect(isValidTraceId(span.traceId)).toBe(true)
    }
  })

  it('records an error', () => {
    let rec: SpanRecord | undefined
    startSpan('prompt.send', { writer: (r) => { rec = r } }).end(undefined, 'refused')
    expect(rec?.error).toBe('refused')
  })
})

describe('spanLogFields', () => {
  it('carries the span keys and attributes, and attributes never overwrite span keys', () => {
    const fields = spanLogFields({
      name: 'prompt.send', traceId: TRACE, spanId: SPAN, parentSpanId: '1111222233334444', kind: 'client',
      startMs: 0, endMs: 5, durationMs: 5, attributes: { surface: 'studio-web', span_id: 'spoof', error: 'spoof' },
    })
    expect(fields).toEqual({
      surface: 'studio-web', trace_id: TRACE, span_id: SPAN, parent_span_id: '1111222233334444',
      duration_ms: 5, span_kind: 'client',
    })
  })

  it('omits parent_span_id for a root and carries error when set', () => {
    const fields = spanLogFields({
      name: 'prompt.send', traceId: TRACE, spanId: SPAN, kind: 'client',
      startMs: 0, endMs: 1, durationMs: 1, attributes: {}, error: 'boom',
    })
    expect(fields.parent_span_id).toBeUndefined()
    expect(fields.error).toBe('boom')
  })
})
