/**
 * transport-frame-breadcrumb.test.ts
 *
 * The main thread once wedged for 30+ minutes inside a relay send with the
 * watchdog counter frozen and spinning=false — stuck in a single UNinstrumented
 * synchronous call. The fine-grained breadcrumbs name the exact hung step.
 *
 * After the compress-once refactor the marks are split by where the work lives:
 *   - sendToAll marks relay_stringify then relay_compress (compression is done
 *     ONCE for all devices), then relay_record / relay_deliver per device.
 *   - buildDeviceFrame marks relay_encrypt (per device, per secret).
 *
 * This pins buildDeviceFrame's relay_encrypt mark; the sendToAll marks are
 * covered in transport-send-breadcrumb.test.ts. Removing the mark turns this red.
 */

import { describe, it, expect, vi } from 'vitest'

const markCalls: number[] = []

vi.mock('../../watchdog', () => ({
  mark: vi.fn((code: number) => { markCalls.push(code) }),
  Activity: {
    Idle: 0, EngineEvent: 1, RelaySend: 2, Retransmit: 3, RendererForward: 4, Snapshot: 5,
    RelayStringify: 6, RelayCompress: 7, RelayEncrypt: 8, RelayRecord: 9, RelayDeliver: 10,
  },
}))

vi.mock('../crypto', () => ({
  encrypt: vi.fn(() => ({ nonce: 'bm9uY2U=', ciphertext: 'Y2lwaGVy' })),
}))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }))

import { buildDeviceFrame } from '../transport-frame'
import { Activity } from '../../watchdog'

const wire = Buffer.from('compressed', 'utf-8')

describe('buildDeviceFrame — relay_encrypt breadcrumb', () => {
  it('marks RelayEncrypt before the AES-GCM call when a 32-byte secret is present', () => {
    markCalls.length = 0
    let seq = 0
    const msg = buildDeviceFrame('device-abc', Buffer.alloc(32, 0x42), '{"type":"desktop_status"}', wire, 'desktop_status', () => ++seq, false)
    expect(msg).not.toBeNull()
    expect(markCalls).toContain(Activity.RelayEncrypt)
    // Compression is the caller's responsibility now — not marked here.
    expect(markCalls).not.toContain(Activity.RelayCompress)
  })

  it('does not mark RelayEncrypt on the plaintext fallback (no 32-byte secret)', () => {
    markCalls.length = 0
    let seq = 0
    buildDeviceFrame('device-abc', Buffer.alloc(8), '{"type":"desktop_status"}', wire, 'desktop_status', () => ++seq, false)
    expect(markCalls).not.toContain(Activity.RelayEncrypt)
  })
})
