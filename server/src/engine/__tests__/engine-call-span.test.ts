/**
 * The hop into the engine is a client->server pair: send_prompt and
 * send_command each carry the traceparent of an `engine.send_prompt` client
 * span, a child of the caller's span, so the engine's run.execute server span
 * is that call's child and a trace backend draws the server->engine edge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spanLines: Array<Record<string, unknown>> = []
vi.mock('../../logger', () => {
  const capture = (tag: string, _msg: string, fields?: Record<string, unknown>) => {
    if (tag === 'span' && fields) spanLines.push({ name: _msg, ...fields })
  }
  return { debug: vi.fn(), error: vi.fn(), trace: vi.fn(), log: capture, warn: capture }
})
vi.mock('../../identity/request-principal', () => ({ currentPrincipal: () => undefined, currentClaims: () => undefined }))
vi.mock('../../protocol/tabs-index', () => ({ principalSubjectForTab: () => undefined }))

import { sendCommand, sendPrompt } from '../engine-bridge-core'
import { parseTraceparent } from '@ion/shared/trace-context'
import type { EngineBridge } from '../engine-bridge'

const CALLER_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const CALLER_SPAN = '1111222233334444'
const TRACEPARENT = `00-${CALLER_TRACE}-${CALLER_SPAN}-01`

function fakeBridge(result: { ok: boolean; error?: string }) {
  const sent: Array<Record<string, unknown>> = []
  const bridge = {
    connect: vi.fn(async () => {}),
    _sendWithResult: vi.fn(async (msg: Record<string, unknown>) => { sent.push(msg); return result }),
    _send: vi.fn((msg: Record<string, unknown>) => { sent.push(msg) }),
  }
  return { bridge: bridge as unknown as EngineBridge, sent }
}

beforeEach(() => { spanLines.length = 0 })

describe('engine.send_prompt client span', () => {
  it('send_prompt carries a client child of the caller span and records it', async () => {
    const { bridge, sent } = fakeBridge({ ok: true })
    await sendPrompt(bridge, 'k1', 'hi', { traceparent: TRACEPARENT })

    const carried = parseTraceparent(sent[0].traceparent)
    expect(carried?.traceId).toBe(CALLER_TRACE)
    expect(carried?.spanId).not.toBe(CALLER_SPAN)
    expect(spanLines).toHaveLength(1)
    expect(spanLines[0]).toMatchObject({
      name: 'engine.send_prompt',
      trace_id: CALLER_TRACE,
      span_id: carried?.spanId,
      parent_span_id: CALLER_SPAN,
      span_kind: 'client',
      'peer.service': 'ion-engine',
      accepted: true,
    })
  })

  it('marks the call failed when the engine refuses', async () => {
    const { bridge } = fakeBridge({ ok: false, error: 'busy' })
    await sendPrompt(bridge, 'k1', 'hi', { traceparent: TRACEPARENT })
    expect(spanLines[0]).toMatchObject({ span_kind: 'client', error: 'send_prompt refused: busy' })
  })

  it('send_command carries its own client span', () => {
    const { bridge, sent } = fakeBridge({ ok: true })
    sendCommand(bridge, { key: 'k1', text: '/review', traceparent: TRACEPARENT }, 'review', '')
    const carried = parseTraceparent(sent[0].traceparent)
    expect(carried?.traceId).toBe(CALLER_TRACE)
    expect(spanLines[0]).toMatchObject({ name: 'engine.send_prompt', span_id: carried?.spanId, parent_span_id: CALLER_SPAN, span_kind: 'client' })
  })

  it('records no span and sends no traceparent without a caller trace', async () => {
    const { bridge, sent } = fakeBridge({ ok: true })
    await sendPrompt(bridge, 'k1', 'hi', {})
    expect(sent[0]).not.toHaveProperty('traceparent')
    expect(spanLines).toHaveLength(0)
  })
})
