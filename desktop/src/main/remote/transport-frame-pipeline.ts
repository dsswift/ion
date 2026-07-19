/**
 * Pure per-device wire-frame build pipeline, shared by the main-thread send
 * path (transport-frame.ts / transport-send.ts) and the transport crypto
 * worker (transport-crypto-worker.ts).
 *
 * PURITY CONTRACT: this module may import only pure Node code (crypto-core,
 * transport-compression, protocol types). No logger, no watchdog, no electron
 * — it must load cleanly inside a worker_threads context. Logging and watchdog
 * breadcrumbs are the callers' responsibility (transport-frame.ts on the main
 * thread; the crypto host when processing worker replies).
 *
 * The seq is provided by the caller, NOT allocated here: the main thread
 * allocates per-device seqs at job-post time (in drain order) so wire seq
 * order is identical whether frames are built synchronously or on the worker.
 */

import { encrypt } from './crypto-core'
import { compressPayload } from './transport-compression'
import type { WireMessage } from './protocol'

/** Per-device build instruction: the device and its pre-allocated wire seq. */
export interface PipelineDevice {
  deviceId: string
  seq: number
}

/** Push metadata + epoch options carried onto every built frame. */
export interface PipelineOpts {
  push: boolean
  pushTitle?: string
  pushBody?: string
  /** Outbound-seq epoch (generation id); see WireMessage.epoch. */
  epoch?: number
}

/** One device's build outcome. `frame` is null when encryption failed. */
export interface PipelineResult {
  deviceId: string
  seq: number
  frame: WireMessage | null
  /** JSON.stringify(frame).length — the exact wire size, for the frame cap. 0 when frame is null. */
  serializedLength: number
  /** Encryption failure message when frame is null. */
  error?: string
}

/**
 * Build one device's frame from the pre-compressed wire buffer. Byte-identical
 * to the historical buildDeviceFrame envelope: encrypted payload when the
 * secret is a 32-byte key, legacy plaintext passthrough otherwise.
 */
export function buildFrameCore(
  deviceId: string,
  secret: Buffer,
  plaintext: string,
  wire: Buffer,
  seq: number,
  sendTs: number,
  opts: PipelineOpts,
): { frame: WireMessage | null; error?: string } {
  const msg: WireMessage = { seq, ts: sendTs, deviceId } as WireMessage
  if (opts.epoch !== undefined) {
    msg.epoch = opts.epoch
  }
  if (secret.length === 32) {
    try {
      const { nonce, ciphertext } = encrypt(wire, secret)
      ;(msg as any).nonce = nonce
      ;(msg as any).ciphertext = ciphertext
    } catch (err) {
      return { frame: null, error: (err as Error).message }
    }
  } else {
    ;(msg as any).payload = plaintext
  }
  ;(msg as any).push = opts.push || undefined
  ;(msg as any).pushTitle = opts.push ? opts.pushTitle : undefined
  ;(msg as any).pushBody = opts.push ? opts.pushBody : undefined
  return { frame: msg }
}

/**
 * Build frames for one event across a device set: compress ONCE (DEFLATE is
 * deterministic — identical bytes for every device), then encrypt per device.
 * Returns the compressed wire size (for telemetry) and per-device results in
 * the order of `devices` (which the caller produced in seq-allocation order).
 * A device missing from `secrets` yields a null frame with an error.
 */
export function buildFramesForEvent(
  plaintext: string,
  devices: PipelineDevice[],
  secrets: Map<string, Buffer>,
  opts: PipelineOpts,
): { wireBytes: number; results: PipelineResult[] } {
  const wire = compressPayload(plaintext)
  const sendTs = Date.now()
  const results: PipelineResult[] = devices.map(({ deviceId, seq }) => {
    const secret = secrets.get(deviceId)
    if (!secret) {
      return { deviceId, seq, frame: null, serializedLength: 0, error: 'no secret for device' }
    }
    const { frame, error } = buildFrameCore(deviceId, secret, plaintext, wire, seq, sendTs, opts)
    return {
      deviceId,
      seq,
      frame,
      serializedLength: frame ? JSON.stringify(frame).length : 0,
      error,
    }
  })
  return { wireBytes: wire.length, results }
}
