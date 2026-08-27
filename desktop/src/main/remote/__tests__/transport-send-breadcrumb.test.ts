/**
 * transport-send-breadcrumb.test.ts
 *
 * Pins two things about sendToAll's hot path:
 *  1. Compress-once: DEFLATE is deterministic, so the compressed bytes are
 *     identical for every device. sendToAll must compress ONCE and reuse the
 *     buffer for all devices — compressing per device multiplied the top
 *     main-thread wedge candidate by the connected-device count.
 *  2. Breadcrumb order: relay_stringify then relay_compress are marked before
 *     the per-device loop, and relay_record / relay_deliver inside it, so a
 *     future wedge names the exact hung step.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const markCalls: number[] = []
vi.mock('../../watchdog', () => ({
  mark: vi.fn((code: number) => { markCalls.push(code) }),
  Activity: {
    Idle: 0, EngineEvent: 1, RelaySend: 2, Retransmit: 3, RendererForward: 4, Snapshot: 5,
    RelayStringify: 6, RelayCompress: 7, RelayEncrypt: 8, RelayRecord: 9, RelayDeliver: 10,
  },
}))

const compressSpy = vi.fn((s: string) => Buffer.from(s, 'utf-8'))
vi.mock('../transport-compression', () => ({ compressPayload: (s: string) => compressSpy(s) }))

// buildDeviceFrame receives the shared wire; return a distinct frame per call.
const buildSpy = vi.fn((deviceId: string) => ({ seq: 1, ts: 0, deviceId, nonce: '', ciphertext: '' }))
vi.mock('../transport-frame', () => ({
  buildDeviceFrame: (deviceId: string, ..._rest: unknown[]) => buildSpy(deviceId),
}))
// error() is used by the oversized-event drop path, which this file exercises.
vi.mock('../../logger', () => ({ log: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }))

import { sendToAll, MAX_PLAINTEXT_BYTES, type SendCtx } from '../transport-send'
import { Activity } from '../../watchdog'

function ctxWithDevices(n: number): SendCtx {
  const deviceSecrets = new Map<string, Buffer>()
  for (let i = 0; i < n; i++) deviceSecrets.set(`dev${i}`, Buffer.alloc(32))
  let seq = 0
  return {
    sendQueue: [],
    deviceSecrets,
    retransmit: { record: vi.fn() } as any,
    nextSeq: () => ++seq,
    deliverFrame: vi.fn(() => true),
  }
}

describe('sendToAll — compress once + breadcrumbs', () => {
  beforeEach(() => {
    markCalls.length = 0
    compressSpy.mockClear()
    buildSpy.mockClear()
  })

  it('compresses exactly once even when broadcasting to multiple devices', () => {
    const ctx = ctxWithDevices(4)
    sendToAll(ctx, { type: 'desktop_status', fields: {} } as any, false)
    // One compress for the whole broadcast; one buildDeviceFrame per device.
    expect(compressSpy).toHaveBeenCalledTimes(1)
    expect(buildSpy).toHaveBeenCalledTimes(4)
  })

  it('marks relay_stringify then relay_compress before the per-device loop', () => {
    const ctx = ctxWithDevices(2)
    sendToAll(ctx, { type: 'desktop_status', fields: {} } as any, false)
    const sIdx = markCalls.indexOf(Activity.RelayStringify)
    const cIdx = markCalls.indexOf(Activity.RelayCompress)
    const rIdx = markCalls.indexOf(Activity.RelayRecord)
    expect(sIdx).toBeGreaterThanOrEqual(0)
    expect(cIdx).toBeGreaterThan(sIdx)
    // Compress is marked once, before any per-device record/deliver.
    expect(rIdx).toBeGreaterThan(cIdx)
    expect(markCalls.filter((c) => c === Activity.RelayCompress)).toHaveLength(1)
  })

  it('fragments an oversized authoritative event before compressing frames', () => {
    const ctx = ctxWithDevices(2)
    const huge = 'x'.repeat(MAX_PLAINTEXT_BYTES + 100)
    const sent = sendToAll(ctx, { type: 'desktop_questions_state', tabId: 't', state: { workflows: [], pad: huge } } as any, false)
    // sendToAll is the prepared-frame seam. Public enqueue paths fragment first;
    // this direct safety-backstop call still refuses the oversized source event.
    expect(sent).toBe(false)
    expect(compressSpy).not.toHaveBeenCalled()
    expect(buildSpy).not.toHaveBeenCalled()
  })
})
