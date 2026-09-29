/**
 * What the wire-latency measure counts.
 *
 * The measure this replaced timed frames one way from the desktop to the
 * phone, over a transport ADR-035 removed -- so its dashboard queried fields
 * nothing emitted and read as a quiet system. This one times a round trip on
 * the server's own clock, which needs no clock-skew estimate and reads the
 * same for every client and every route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const logger = vi.hoisted(() => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../logger', () => logger)

import {
  WireLatencyMeter,
  WIRE_WINDOW_FIELDS,
  PING_TIMEOUT_MS,
  logWireWindow,
} from '../wire-latency'

beforeEach(() => {
  for (const fn of Object.values(logger)) fn.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('WireLatencyMeter', () => {
  it('times a round trip on one clock, with no skew to correct', () => {
    const meter = new WireLatencyMeter()
    meter.recordPingSent('n1', 1_000)
    // The client's own clock is irrelevant: both readings below are the
    // server's, which is the whole reason this replaced one-way timing.
    expect(meter.recordPong('n1', 1_042)).toBe(42)

    const window = meter.takeWindow()
    expect(window.rtt_samples).toBe(1)
    expect(window.rtt_p50_ms).toBe(42)
    expect(window.rtt_max_ms).toBe(42)
  })

  it('reports percentiles over the window', () => {
    const meter = new WireLatencyMeter()
    for (let i = 1; i <= 100; i++) {
      meter.recordPingSent(`n${i}`, 0)
      meter.recordPong(`n${i}`, i)
    }
    const window = meter.takeWindow()
    expect(window.rtt_p50_ms).toBe(50)
    expect(window.rtt_p95_ms).toBe(95)
    expect(window.rtt_max_ms).toBe(100)
    expect(window.rtt_samples).toBe(100)
  })

  it('writes off a probe that is never answered', () => {
    const meter = new WireLatencyMeter()
    meter.recordPingSent('lost', 1_000)
    meter.expireStalePings(1_000 + PING_TIMEOUT_MS)

    const window = meter.takeWindow()
    expect(window.pings_lost).toBe(1)
    expect(window.rtt_samples).toBe(0)
    // No samples is not a latency of zero; rtt_samples is what says which.
    expect(window.rtt_p95_ms).toBe(0)
  })

  it('ignores a pong for a probe it has no record of', () => {
    const meter = new WireLatencyMeter()
    expect(meter.recordPong('never-sent', 1_000)).toBeNull()
    expect(meter.takeWindow().rtt_samples).toBe(0)
  })

  it('counts what only the server can see: queue wait, bytes, frames, decode errors', () => {
    const meter = new WireLatencyMeter()
    meter.recordSend(100, 100)
    meter.recordSendComplete(5)
    meter.recordSend(400, 500)
    meter.recordSendComplete(25)
    meter.recordInbound()
    meter.recordInbound()
    meter.recordDecodeError()
    meter.recordAction(10)
    meter.recordAction(30)

    const window = meter.takeWindow()
    expect(window.frames_out).toBe(2)
    expect(window.bytes_out).toBe(500)
    expect(window.queue_max).toBe(500)
    expect(window.dwell_p50_ms).toBe(5)
    expect(window.dwell_max_ms).toBe(25)
    expect(window.frames_in).toBe(2)
    expect(window.decode_errors).toBe(1)
    expect(window.action_p50_ms).toBe(10)
    expect(window.action_p95_ms).toBe(30)
  })

  it('starts a fresh window after each one is taken', () => {
    const meter = new WireLatencyMeter()
    meter.recordSend(10, 10)
    meter.takeWindow()

    expect(meter.hasSamples()).toBe(false)
    expect(meter.takeWindow().frames_out).toBe(0)
  })
})

describe('the window line', () => {
  it('carries every field the dashboard queries', () => {
    const meter = new WireLatencyMeter()
    meter.recordPingSent('n', 0)
    meter.recordPong('n', 12)
    meter.recordSend(50, 50)
    meter.recordSendComplete(2)

    logWireWindow({ clientKind: 'mobile', clientId: 'phone-1', transport: 'relay', connectionId: 'c-1' }, meter)

    expect(logger.log).toHaveBeenCalledOnce()
    const [tag, msg, fields] = logger.log.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(tag).toBe('wire-latency')
    expect(msg).toBe('wire window')
    for (const field of WIRE_WINDOW_FIELDS) {
      expect(fields, `window line is missing ${field}`).toHaveProperty(field)
    }
    expect(fields.client_kind).toBe('mobile')
    expect(fields.transport).toBe('relay')
  })

  it('says nothing about a connection that did nothing', () => {
    logWireWindow({ clientKind: 'studio', clientId: 'c', transport: 'local', connectionId: 'c-2' }, new WireLatencyMeter())
    expect(logger.log).not.toHaveBeenCalled()
  })
})
