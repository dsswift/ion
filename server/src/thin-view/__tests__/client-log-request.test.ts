/** The server asks a thin client for its log lines past the cursor it holds for that client. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cursor = vi.hoisted(() => ({ byClient: new Map<string, number>() }))
vi.mock('../../remote/handlers/diagnostics', () => ({
  PERIODIC_LOG_PULL_INTERVAL_MS: 5_000,
  diagnosticLogCursor: (client: string) => cursor.byClient.get(client) ?? 0,
}))
vi.mock('../../state', () => ({ state: { remoteTransport: null } }))
vi.mock('../../git/focus-state', () => ({ focusState: { setRemoteClientCount: vi.fn() } }))

import { Connection, connectionRegistry } from '../../protocol/connection'
import { requestClientLogs, startClientLogRequests, stopClientLogRequests } from '../client-log-request'

function conn(view: 'thin' | 'mirror', pairedClientId: string | null): { conn: Connection; frames: () => unknown[] } {
  const sent: string[] = []
  const c = new Connection({ send: (d: string, cb?: () => void) => { sent.push(d); cb?.() }, close: vi.fn(), terminate: vi.fn(), on: vi.fn(), ping: vi.fn() } as never, 'tcp')
  c.view = view
  c.clientId = 'hello-id'
  c.pairedClientId = pairedClientId
  connectionRegistry.add(c)
  return { conn: c, frames: () => sent.map((t) => JSON.parse(t) as unknown) }
}

beforeEach(() => { vi.useFakeTimers(); cursor.byClient.clear() })
afterEach(() => {
  stopClientLogRequests()
  for (const c of connectionRegistry.all()) connectionRegistry.remove(c)
  vi.useRealTimers()
})

describe('requestClientLogs', () => {
  it('asks with the cursor persisted for that pairing, on studio:client-log-request', () => {
    cursor.byClient.set('phone-1', 41)
    const phone = conn('thin', 'phone-1')
    expect(requestClientLogs(phone.conn)).toBe(true)
    expect(phone.frames()).toEqual([{ type: 'studio_event', channel: 'studio:client-log-request', payload: { sinceSeq: 41 } }])
  })

  it('never asks a mirror connection', () => {
    const desk = conn('mirror', null)
    expect(requestClientLogs(desk.conn)).toBe(false)
    expect(desk.frames()).toEqual([])
  })
})

describe('startClientLogRequests', () => {
  it('asks every thin connection each interval, with its current cursor, and stops with the last one', () => {
    const phone = conn('thin', 'phone-1')
    const desk = conn('mirror', null)
    startClientLogRequests()
    vi.advanceTimersByTime(5_000)
    cursor.byClient.set('phone-1', 7)
    vi.advanceTimersByTime(5_000)
    expect(phone.frames().map((f) => (f as { payload: { sinceSeq: number } }).payload.sinceSeq)).toEqual([0, 7])
    expect(desk.frames()).toEqual([])

    connectionRegistry.remove(phone.conn)
    vi.advanceTimersByTime(5_000)
    const before = phone.frames().length
    vi.advanceTimersByTime(20_000)
    expect(phone.frames()).toHaveLength(before)
  })
})
