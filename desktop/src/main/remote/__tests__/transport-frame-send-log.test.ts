/**
 * transport-frame-send-log.test.ts
 *
 * Pinning test for the per-frame send logging on buildDeviceFrame.
 *
 * Verifies that buildDeviceFrame:
 * 1. Accepts the precompressed `wire` buffer + `eventType` (compression is done
 *    once by the caller now, not per device inside this function)
 * 2. Accepts an optional `enqueuedAt` parameter for queue_dwell_ms
 * 3. Returns a frame with `seq`, `ts`, `deviceId`
 * 4. Emits the per-frame line at INFO with event_type taken from the passed
 *    eventType (no per-device JSON re-parse)
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../crypto', () => ({
  encrypt: vi.fn((_data: Buffer, _secret: Buffer) => ({
    nonce: Buffer.alloc(12),
    ciphertext: Buffer.alloc(32),
  })),
}))

vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}))

import { buildDeviceFrame } from '../transport-frame'

describe('buildDeviceFrame — per-frame send logging', () => {
  const deviceId = 'device-abc123'
  const secret = Buffer.alloc(32, 0x42)
  const plaintext = JSON.stringify({ type: 'desktop_snapshot', tabs: [] })
  const wire = Buffer.from(plaintext, 'utf-8') // stand-in compressed buffer
  const eventType = 'desktop_snapshot'
  let seq = 0
  const nextSeq = () => ++seq

  it('accepts precompressed wire + eventType and returns a WireMessage', () => {
    const enqueuedAt = Date.now() - 50 // simulated 50ms queue dwell
    const msg = buildDeviceFrame(deviceId, secret, plaintext, wire, eventType, nextSeq, false, undefined, undefined, enqueuedAt)
    expect(msg).not.toBeNull()
  })

  it('returns a frame with seq, ts, and deviceId', () => {
    const msg = buildDeviceFrame(deviceId, secret, plaintext, wire, eventType, nextSeq, false)
    expect(msg).not.toBeNull()
    expect(typeof (msg as any).seq).toBe('number')
    expect(typeof (msg as any).ts).toBe('number')
    expect((msg as any).deviceId).toBe(deviceId)
  })

  it('queue_dwell_ms is computable from enqueuedAt', () => {
    const enqueuedAt = Date.now() - 100 // 100ms ago
    const msg = buildDeviceFrame(deviceId, secret, plaintext, wire, eventType, nextSeq, false, undefined, undefined, enqueuedAt)
    expect(msg).not.toBeNull()
    const sendTs: number = (msg as any).ts
    const dwell = sendTs - enqueuedAt
    expect(dwell).toBeGreaterThanOrEqual(99) // allow 1ms fuzz
  })

  it('omits enqueuedAt gracefully when not provided (backward compat)', () => {
    const msg = buildDeviceFrame(deviceId, secret, plaintext, wire, eventType, nextSeq, false)
    expect(msg).not.toBeNull()
    expect((msg as any).seq).toBeGreaterThan(0)
  })

  it('emits the per-frame send line at DEBUG with the passed eventType', async () => {
    // buildDeviceFrame logs via debug() (DEBUG) — at 135k lines/hour at INFO this
    // single call dominated desktop log volume (~88%). Demoted to DEBUG so the line
    // is only present when the operator has opted into verbose logging; it is still
    // available for local diagnostics but never ships to Loki at the INFO floor.
    // event_type comes from the eventType argument, not a re-parse of plaintext.
    const { debug: debugSpy } = vi.mocked(await import('../../logger'))
    debugSpy.mockClear()
    buildDeviceFrame(deviceId, secret, plaintext, wire, eventType, nextSeq, false, undefined, undefined, Date.now() - 5)
    expect(debugSpy).toHaveBeenCalledWith(
      'transport-frame',
      expect.stringContaining('seq='),
      expect.objectContaining({ fields: expect.objectContaining({ event_type: 'desktop_snapshot' }) }),
    )
  })
})
