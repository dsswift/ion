/**
 * Every engine round trip is one `engine.request` client span whose
 * traceparent rides the command, so the engine's `command.dispatch` is its
 * child; a command that already carries a traceparent (a prompt, whose call
 * span is `engine.send_prompt`) gets no second span; a timeout fails it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '') }))
vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn(() => '') }))
const logger = vi.hoisted(() => ({ log: vi.fn(), trace: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('../../logger', () => logger)

import { EngineBridge } from '../engine-bridge'
import { withSpan } from '../../tracing/op-span'
import { capturedSpans, theSpan } from '../../tracing/__tests__/span-capture'
import { parseTraceparent } from '@ion/shared/trace-context'

function makeBridge(): EngineBridge & { conn: { write: ReturnType<typeof vi.fn> } } {
  const bridge = new EngineBridge()
  const mockConn = { destroyed: false, write: vi.fn(() => true), destroy: vi.fn(), on: vi.fn() }
  ;(bridge as any).conn = mockConn
  ;(bridge as any).connected = true
  return bridge as never
}

function written(bridge: { conn: { write: ReturnType<typeof vi.fn> } }): Record<string, unknown> {
  return JSON.parse(String(bridge.conn.write.mock.calls.at(-1)?.[0])) as Record<string, unknown>
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(logger)) fn.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('engine.request', () => {
  it('spans a request as a child of the ambient span and puts its traceparent on the command', async () => {
    const bridge = makeBridge()
    await withSpan('action.handle', { kind: 'server' }, async (outer) => {
      const pending = (bridge as any)._sendWithData({ cmd: 'get_system_metrics' })
      const msg = written(bridge)
      const parsed = parseTraceparent(msg.traceparent)
      expect(parsed?.traceId).toBe(outer.traceId)
      const callback = bridge.requestCallbacks.get(msg.requestId as string)!
      callback({ ok: true, data: { x: 1 } } as never)
      expect(await pending).toMatchObject({ ok: true, data: { x: 1 } })
      const span = theSpan(logger, 'engine.request')
      expect(span.fields).toMatchObject({ span_kind: 'client', command: 'get_system_metrics', 'peer.service': 'ion-engine', answered: true, ok: true, parent_span_id: outer.spanId })
      expect(span.fields.span_id).toBe(parsed?.spanId)
    })
  })

  it('writes no span for a command that already names its own call span', () => {
    const bridge = makeBridge()
    void (bridge as any)._sendWithResult({ cmd: 'send_prompt', key: 't1', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-1111222233334444-01' })
    expect(written(bridge).traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-1111222233334444-01')
    expect(capturedSpans(logger)).toEqual([])
  })

  it('fails the span when the engine never answers', async () => {
    const bridge = makeBridge()
    const pending = (bridge as any)._sendWithResult({ cmd: 'list_sessions' })
    vi.advanceTimersByTime(30_000)
    expect(await pending).toMatchObject({ ok: false, unanswered: true })
    const span = theSpan(logger, 'engine.request')
    expect(span.level).toBe('WARN')
    expect(span.fields).toMatchObject({ command: 'list_sessions', answered: false, error: 'request timed out' })
  })
})
