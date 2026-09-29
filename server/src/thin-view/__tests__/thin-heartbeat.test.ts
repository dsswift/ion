/**
 * A thin client measures its link by timing these.
 *
 * Regression: `desktop_heartbeat` outlived the `desktop_*` transport that
 * emitted it. The payload type and the client's signal meter both survived
 * the wire's deletion while its only producer did not, so a phone on a
 * healthy relay connection read "No Signal" indefinitely.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../state', () => ({ state: {} }))

import { Connection, connectionRegistry } from '../../protocol/connection'
import type { ConnectionSocket } from '../../protocol/connection-socket'
import { decodeFrame } from '@ion/shared/studio-wire/codec'
import {
  sendThinHeartbeat,
  startThinHeartbeat,
  stopThinHeartbeat,
  THIN_HEARTBEAT_INTERVAL_MS,
  _resetThinHeartbeatForTest,
} from '../thin-heartbeat'

function thinConn(): { conn: Connection; beats: () => Array<Record<string, unknown>> } {
  const sent: string[] = []
  const socket = {
    send: (data: string, cb?: (err?: Error) => void) => { sent.push(data); cb?.() },
    close: vi.fn(), terminate: vi.fn(), on: vi.fn(), ping: vi.fn(),
  } as unknown as ConnectionSocket
  const conn = new Connection(socket, 'tcp')
  conn.view = 'thin'
  conn.principal = { subject: 'user:alice', displayName: 'alice' }
  connectionRegistry.add(conn)
  return {
    conn,
    beats: () => sent
      .map((t) => decodeFrame(t))
      .filter((f): f is Extract<typeof f, { type: 'studio_event' }> => f.type === 'studio_event')
      .map((f) => f.payload as Record<string, unknown>)
      .filter((p) => p.type === 'desktop_heartbeat'),
  }
}

beforeEach(() => {
  for (const conn of connectionRegistry.all()) connectionRegistry.remove(conn)
  _resetThinHeartbeatForTest()
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); _resetThinHeartbeatForTest() })

describe('thin heartbeat', () => {
  it('carries a clock reading the client can time, and its own queue depth', () => {
    const alice = thinConn()

    expect(sendThinHeartbeat(alice.conn)).toBe(true)

    const beat = alice.beats()[0]
    expect(typeof beat.ts).toBe('number')
    expect(beat.ts as number).toBeGreaterThan(0)
    expect(beat.buffered).toBe(alice.conn.buffer.size)
    expect(beat.seq).toBe(1)
  })

  it('beats inside the client meter\'s staleness window', () => {
    // The meter reads a sample older than 45s as no signal and older than
    // 15s as degraded, so the interval has to sit under both.
    expect(THIN_HEARTBEAT_INTERVAL_MS).toBeLessThan(15_000)
  })

  it('beats to every attached thin connection on the interval', () => {
    const alice = thinConn()
    const bob = thinConn()
    startThinHeartbeat()

    vi.advanceTimersByTime(THIN_HEARTBEAT_INTERVAL_MS * 2)

    expect(alice.beats()).toHaveLength(2)
    expect(bob.beats()).toHaveLength(2)
    expect(alice.beats().map((b) => b.seq)).not.toEqual([0, 0])
    stopThinHeartbeat()
  })

  it('stops itself once the last thin connection goes away', () => {
    const alice = thinConn()
    startThinHeartbeat()
    vi.advanceTimersByTime(THIN_HEARTBEAT_INTERVAL_MS)
    expect(alice.beats()).toHaveLength(1)

    connectionRegistry.remove(alice.conn)
    vi.advanceTimersByTime(THIN_HEARTBEAT_INTERVAL_MS * 3)

    expect(alice.beats()).toHaveLength(1)
  })
})
