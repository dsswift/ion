/**
 * Every `studio_action` is one `action.handle` span, receipt to result sent,
 * parented where the frame says: the sealed envelope's traceparent first (the
 * relay's span), then the frame's own, then one carried in the arguments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), info: vi.fn(), logWeb: vi.fn(), flushLogs: vi.fn() }))
vi.mock('../../logger', () => logger)
vi.mock('../../state', () => ({
  engineBridge: { connected: true },
  deviceFocusMap: new Map(),
  state: { remoteTransport: null },
  enterprisePolicyCache: { policy: null },
  sessionPlane: {},
}))

import { actionParent, handleAction } from '../actions'
import { recordingConnection } from './recording-connection'
import { capturedSpans, theSpan } from '../../tracing/__tests__/span-capture'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

type ActionFrame = Extract<StudioFrame, { type: 'studio_action' }>
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const RELAY_SPAN = 'aaaaaaaaaaaaaaaa'
const CLIENT_SPAN = 'bbbbbbbbbbbbbbbb'
const ARG_SPAN = 'cccccccccccccccc'
const tp = (span: string): string => `00-${TRACE}-${span}-01`

beforeEach(() => {
  for (const fn of Object.values(logger)) fn.mockClear()
})

describe('action.handle', () => {
  it('spans an action receipt to result, with the action, surface, client kind, and outcome', async () => {
    const { conn, sent } = recordingConnection({ view: 'thin' })
    conn.clientKind = 'mobile'
    conn.principal = { subject: 'local:josh', displayName: 'Josh' } as never
    const frame: ActionFrame = { type: 'studio_action', id: 'a1', action: 'no.such.action', args: [] }
    await handleAction(conn, frame)
    expect(sent).toHaveLength(1)
    const span = theSpan(logger, 'action.handle')
    expect(span.fields).toMatchObject({
      span_kind: 'server',
      action: 'no.such.action',
      surface: 'thin',
      client_kind: 'mobile',
      transport: 'tcp',
      user: 'local:josh',
      outcome: 'error:unknown_action',
    })
    expect(typeof span.fields.duration_ms).toBe('number')
    expect(span.fields.parent_span_id).toBeUndefined()
  })

  it('prefers the envelope traceparent, then the frame, then an argument', () => {
    const frame = (traceparent?: string, args: unknown[] = []): ActionFrame => ({ type: 'studio_action', id: 'a', action: 'x', args, traceparent })
    expect(actionParent(frame(tp(CLIENT_SPAN), [{ traceparent: tp(ARG_SPAN) }]), tp(RELAY_SPAN))).toBe(tp(RELAY_SPAN))
    expect(actionParent(frame(tp(CLIENT_SPAN), [{ traceparent: tp(ARG_SPAN) }]), undefined)).toBe(tp(CLIENT_SPAN))
    expect(actionParent(frame(undefined, ['t1', { traceparent: tp(ARG_SPAN) }]), undefined)).toBe(tp(ARG_SPAN))
    expect(actionParent(frame('garbage', [{ traceparent: 'also garbage' }]), 'nope')).toBeUndefined()
  })

  it('joins the relay-injected envelope traceparent so the server parents under the relay', async () => {
    const { conn } = recordingConnection()
    await handleAction(conn, { type: 'studio_action', id: 'a2', action: 'no.such.action', args: [], traceparent: tp(CLIENT_SPAN) }, tp(RELAY_SPAN))
    const span = theSpan(logger, 'action.handle')
    expect(span.fields.trace_id).toBe(TRACE)
    expect(span.fields.parent_span_id).toBe(RELAY_SPAN)
  })

  it('joins the frame traceparent when no envelope carried one', async () => {
    const { conn } = recordingConnection()
    await handleAction(conn, { type: 'studio_action', id: 'a3', action: 'no.such.action', args: [], traceparent: tp(CLIENT_SPAN) })
    expect(theSpan(logger, 'action.handle').fields.parent_span_id).toBe(CLIENT_SPAN)
    expect(capturedSpans(logger)).toHaveLength(1)
  })
})
