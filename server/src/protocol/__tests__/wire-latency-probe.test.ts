/**
 * Who gets probed.
 *
 * `studio_ping` is a frame a client that predates it would refuse to decode,
 * and the codec's refusal closes the connection -- so an unrecognised probe is
 * far worse than a missing measurement. A phone on an older build is exactly
 * that client, which is why the capability gates it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logger = vi.hoisted(() => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../logger', () => logger)

import { WIRE_PING_CAPABILITY } from '@ion/shared/studio-wire/types'
import { WireLatencyMeter } from '../wire-latency'
import { probeConnection, flushConnectionWindow } from '../wire-latency-probe'
import type { Connection } from '../connection'

/** The parts of a Connection the probe touches. */
function fakeConnection(overrides: Partial<{ capabilities: string[]; isClosed: boolean }> = {}) {
  const sent: unknown[] = []
  const capabilities = overrides.capabilities ?? [WIRE_PING_CAPABILITY]
  const conn = {
    id: 'c-1',
    transport: 'tcp' as const,
    clientKind: 'studio',
    clientId: 'studio-1',
    isClosed: overrides.isClosed ?? false,
    hasCapability: (c: string) => capabilities.includes(c),
    latency: new WireLatencyMeter(),
    send: (frame: unknown) => { sent.push(frame); return true },
  }
  return { conn: conn as unknown as Connection, sent, meter: conn.latency }
}

beforeEach(() => {
  for (const fn of Object.values(logger)) fn.mockClear()
})

describe('probeConnection', () => {
  it('probes a client that says it can answer', () => {
    const { conn, sent } = fakeConnection()
    expect(probeConnection(conn)).toBe(true)

    expect(sent).toHaveLength(1)
    const frame = sent[0] as { type: string; nonce: string; t: number }
    expect(frame.type).toBe('studio_ping')
    expect(frame.nonce).toMatch(/^[0-9a-f]{16}$/)
    expect(frame.t).toBeGreaterThan(0)
  })

  it('never probes a client that did not advertise the capability', () => {
    const { conn, sent } = fakeConnection({ capabilities: [] })
    expect(probeConnection(conn)).toBe(false)
    expect(sent).toEqual([])
  })

  it('never probes a closed connection', () => {
    const { conn, sent } = fakeConnection({ isClosed: true })
    expect(probeConnection(conn)).toBe(false)
    expect(sent).toEqual([])
  })

  it('counts the probe as outstanding, so an unanswered one is reported lost', () => {
    const { conn, meter } = fakeConnection()
    probeConnection(conn)
    // Far past the timeout: the probe is written off rather than waited on.
    meter.expireStalePings(Date.now() + 120_000)
    expect(meter.takeWindow().pings_lost).toBe(1)
  })

  it('answers a round trip when the pong comes back', () => {
    const { conn, sent, meter } = fakeConnection()
    probeConnection(conn)
    const { nonce } = sent[0] as { nonce: string }

    expect(meter.recordPong(nonce, Date.now() + 7)).toBeGreaterThanOrEqual(0)
    expect(meter.takeWindow().rtt_samples).toBe(1)
  })
})

describe('flushConnectionWindow', () => {
  it('writes what a closing connection measured, which would otherwise go with it', () => {
    const { conn, meter } = fakeConnection()
    meter.recordSend(10, 10)
    meter.recordSendComplete(3)

    flushConnectionWindow(conn)

    expect(logger.log).toHaveBeenCalledOnce()
    const [, msg, fields] = logger.log.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(msg).toBe('wire window')
    expect(fields.connection_id).toBe('c-1')
    expect(fields.frames_out).toBe(1)
  })
})
