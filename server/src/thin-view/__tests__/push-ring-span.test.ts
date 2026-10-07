/** Ringing offline thin clients is one `push.ring` client span whose traceparent each doorbell carries. */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), info: vi.fn() }))
vi.mock('../../logger', () => logger)

import { ringOfflineThinClients, setPushRinger } from '../push-doorbell'
import { runWithTrace } from '../../tracing/op-span'
import { capturedSpans, theSpan } from '../../tracing/__tests__/span-capture'
import { parseTraceparent } from '@ion/shared/trace-context'

beforeEach(() => {
  for (const fn of Object.values(logger)) fn.mockClear()
  setPushRinger(null)
})

describe('push.ring', () => {
  it('hands the ringer its own span as the doorbell traceparent, under the engine event\'s trace', () => {
    const rings: Array<{ kind: string | undefined; traceparent: string }> = []
    setPushRinger((push, traceparent) => { rings.push({ kind: push.notifyKind, traceparent }); return 2 })
    runWithTrace({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' }, () =>
      ringOfflineThinClients({ pushTitle: 'Done', pushTabId: 't1', notifyKind: 'finished' }))
    const span = theSpan(logger, 'push.ring')
    expect(span.fields).toMatchObject({ span_kind: 'client', kind: 'finished', tab_id: 't1', channel_count: 2, trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', parent_span_id: '00f067aa0ba902b7' })
    expect(rings).toHaveLength(1)
    expect(parseTraceparent(rings[0].traceparent)?.spanId).toBe(span.fields.span_id)
  })

  it('writes no span when no relay listener is running', () => {
    ringOfflineThinClients({ pushTitle: 'Done' })
    expect(capturedSpans(logger)).toEqual([])
  })
})
