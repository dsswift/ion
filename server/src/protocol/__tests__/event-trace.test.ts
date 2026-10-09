/**
 * The engine's trace reaches every client: an engine event's `trace_id` /
 * `span_id` are stamped on the `studio_event` frame that carries it and on a
 * thin frame derived from it, the fan-out is one `store.broadcast` span under
 * that trace, and a sealed envelope carries the trace in plaintext both ways.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), info: vi.fn() }))
vi.mock('../../logger', () => logger)
vi.mock('../../state', () => ({
  engineBridge: { connected: true },
  deviceFocusMap: new Map(),
  state: { remoteTransport: null },
  enterprisePolicyCache: { policy: null },
}))
vi.mock('../../config/current', () => ({ unownedTabsVisible: () => true, isSharedTenancy: () => true, currentServerConfig: () => ({}) }))
vi.mock('../../store/startup-progress', () => ({ startupReportForAttach: () => null }))
vi.mock('../../engine/agent-state-mirror', () => ({ listAgentRosters: () => [] }))

import { attachConnectionToEvents, eventTrace, publishStudioEvent, studioEventFrame } from '../events'
import { sendThinEventTo } from '../../thin-view/remote-out'
import { recordingConnection } from './recording-connection'
import { SealedSocket, type EnvelopeCarrier } from '../sealed-socket'
import { Connection } from '../connection'
import { runWithTrace, withSpan } from '../../tracing/op-span'
import { openRelayFrame, sealRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import { capturedSpans, theSpan } from '../../tracing/__tests__/span-capture'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

type EventFrame = Extract<StudioFrame, { type: 'studio_event' }>
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'
const SECRET = Buffer.alloc(32, 7)

beforeEach(() => {
  for (const fn of Object.values(logger)) fn.mockClear()
})

describe('an engine event on the Studio wire', () => {
  it('stamps the event trace on the studio_event frame and spans the fan-out under that trace', () => {
    const { conn, sent } = recordingConnection()
    conn.principal = { subject: 'local:a', displayName: 'A' } as never
    const detach = attachConnectionToEvents(conn)
    const event = { type: 'text_delta', text: 'hi', trace_id: TRACE, span_id: SPAN }
    publishStudioEvent('ion:normalized-event', ['tab-1', event])
    detach()
    const frame = sent.find((f): f is EventFrame => f.type === 'studio_event' && f.channel === 'ion:normalized-event')
    expect(frame).toMatchObject({ trace_id: TRACE, span_id: SPAN })
    const span = theSpan(logger, 'store.broadcast')
    expect(span.fields).toMatchObject({ trace_id: TRACE, parent_span_id: SPAN, channel: 'ion:normalized-event', connections: 1, delivered: 1 })
  })

  it('leaves the ids off a frame no engine event produced, and writes no span with nobody attached', () => {
    const { conn, sent } = recordingConnection()
    const detach = attachConnectionToEvents(conn)
    publishStudioEvent('ion:engine-reconnected', [])
    detach()
    const frame = sent.find((f): f is EventFrame => f.type === 'studio_event' && f.channel === 'ion:engine-reconnected')
    expect(frame).toBeDefined()
    expect(frame).not.toHaveProperty('trace_id')
    logger.log.mockClear()
    publishStudioEvent('ion:engine-reconnected', [])
    expect(capturedSpans(logger)).toEqual([])
  })

  it('reads the trace of a thin event projected from an engine event, and stamps a targeted thin frame', () => {
    expect(eventTrace('studio:thin-event', [{ type: 'desktop_text_delta', trace_id: TRACE, span_id: SPAN }])).toEqual({ traceId: TRACE, spanId: SPAN })
    expect(eventTrace('studio:thin-event', [{ type: 'desktop_text_delta', trace_id: 'short' }])).toBeUndefined()
    const { conn, sent } = recordingConnection({ view: 'thin' })
    runWithTrace({ traceId: TRACE, spanId: SPAN }, () => sendThinEventTo(conn, { type: 'desktop_tab_meta', tabId: 't' }))
    expect(sent[0]).toMatchObject({ type: 'studio_event', trace_id: TRACE, span_id: SPAN })
    expect(studioEventFrame('c', 1, undefined)).toEqual({ type: 'studio_event', channel: 'c', payload: 1 })
  })
})

/** A relay carrier that records what it is handed and lets a test feed it envelopes. */
function fakeCarrier(kind: 'relay' | 'tcp'): EnvelopeCarrier & { sent: string[]; feed(text: string): void } {
  const emitter = new EventEmitter()
  const sent: string[] = []
  return {
    kind,
    sent,
    feed: (text) => emitter.emit('envelope', text),
    sendEnvelope: (text, cb) => { sent.push(text); cb?.() },
    onEnvelope: (listener) => { emitter.on('envelope', listener) },
    onClosed: () => undefined,
    onError: () => undefined,
    close: () => undefined,
    terminate: () => undefined,
    ping: (onPong) => onPong(),
  }
}

describe('a sealed envelope', () => {
  it('reports the inbound envelope traceparent beside the frame, under a relay.frame span parented on it', () => {
    const carrier = fakeCarrier('relay')
    const socket = new SealedSocket(carrier, SECRET, 'client-1')
    const heard: Array<{ text: string; traceparent?: string }> = []
    socket.on('message', (data, _isBinary, meta) => heard.push({ text: data.toString(), traceparent: meta?.traceparent }))
    carrier.feed(sealRelayFrame('{"type":"studio_pong","nonce":"n"}', SECRET, undefined, `00-${TRACE}-${SPAN}-01`))
    carrier.feed(sealRelayFrame('{"type":"studio_pong","nonce":"m"}', SECRET))
    expect(heard).toEqual([
      { text: '{"type":"studio_pong","nonce":"n"}', traceparent: `00-${TRACE}-${SPAN}-01` },
      { text: '{"type":"studio_pong","nonce":"m"}', traceparent: undefined },
    ])
    const spans = capturedSpans(logger).filter((s) => s.name === 'relay.frame')
    expect(spans).toHaveLength(2)
    expect(spans[0].fields).toMatchObject({ direction: 'in', span_kind: 'server', trace_id: TRACE, parent_span_id: SPAN, client_id: 'client-1' })
    expect(spans[1].fields.parent_span_id).toBeUndefined()
  })

  it('puts the ambient span on the outbound envelope: the action span for an answer, the event trace for an event', () => {
    const carrier = fakeCarrier('relay')
    const socket = new SealedSocket(carrier, SECRET, 'client-1')
    const conn = new Connection(socket, 'relay')
    withSpan('action.handle', { kind: 'server' }, () => {
      conn.send({ type: 'studio_action_result', id: 'a', ok: true })
    })
    conn.send({ type: 'studio_event', channel: 'ion:normalized-event', payload: {}, trace_id: TRACE, span_id: SPAN })
    conn.send({ type: 'studio_event', channel: 'ion:engine-reconnected', payload: null })
    const envelopes = carrier.sent.map((text) => JSON.parse(text) as { traceparent?: string })
    const action = theSpan(logger, 'action.handle')
    expect(envelopes[0].traceparent).toBe(`00-${action.fields.trace_id as string}-${action.fields.span_id as string}-01`)
    expect(envelopes[1].traceparent).toBe(`00-${TRACE}-${SPAN}-01`)
    expect(envelopes[2].traceparent).toBeUndefined()
    // The frames still open, so the trace rode beside the ciphertext, not inside it.
    expect(openRelayFrame(carrier.sent[1], SECRET)?.traceparent).toBe(`00-${TRACE}-${SPAN}-01`)
    const out = capturedSpans(logger).filter((s) => s.name === 'relay.frame')
    expect(out).toHaveLength(3)
    expect(out[1].fields).toMatchObject({ direction: 'out', span_kind: 'client', trace_id: TRACE, parent_span_id: SPAN })
  })

  it('writes no relay.frame span on a sealed TCP socket, which still carries the traceparent', () => {
    const carrier = fakeCarrier('tcp')
    const socket = new SealedSocket(carrier, SECRET, 'client-2')
    runWithTrace({ traceId: TRACE, spanId: SPAN }, () => socket.send('{"type":"studio_ping","nonce":"x","t":1}'))
    expect((JSON.parse(carrier.sent[0]) as { traceparent?: string }).traceparent).toBe(`00-${TRACE}-${SPAN}-01`)
    expect(capturedSpans(logger)).toEqual([])
  })
})
