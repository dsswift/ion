import type { WireMessage } from './protocol'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('RetransmitBuffer', msg, fields)
}

/**
 * Per-device retransmit ring buffer for the desktop↔iOS wire.
 *
 * The wire is fire-and-forget: a frame lost in transit (e.g. a LAN↔relay
 * transport switch mid-stream) is gone from the live stream, which freezes the
 * high-rate text/tool delta stream on iOS until the ~10s snapshot reconcile.
 * This buffer keeps the most recently sent encrypted frames per device, keyed
 * by their per-device `seq`, so that when iOS detects a forward seq gap and
 * sends `desktop_request_resend{ fromSeq, toSeq }`, the desktop can replay the
 * exact original frames — byte-identical, because they are the buffered
 * encrypted wire messages.
 *
 * Eviction: oldest-first, bounded by BOTH a message count and a byte budget
 * (whichever trips first), so a long-running stream cannot grow it unbounded.
 * A gap whose frames have been evicted is answered with
 * `desktop_resend_unavailable`, and iOS falls back to the snapshot reconcile.
 */
export class RetransmitBuffer {
  /** Per-device ordered map of seq -> stored frame. Insertion order = seq order
   *  (outbound seq counters are per device, so each device's seqs are both
   *  monotonic AND contiguous: 1,2,3,...), so the first key is the oldest. */
  private byDevice = new Map<string, Map<number, { msg: WireMessage; bytes: number }>>()
  private bytesByDevice = new Map<string, number>()

  constructor(
    private readonly maxMessages = 512,
    private readonly maxBytes = 2 * 1024 * 1024, // 2MB per device
  ) {}

  /** Record a frame that was just sent to `deviceId`. */
  record(deviceId: string, msg: WireMessage): void {
    let buf = this.byDevice.get(deviceId)
    if (!buf) {
      buf = new Map()
      this.byDevice.set(deviceId, buf)
      this.bytesByDevice.set(deviceId, 0)
    }
    // Approximate wire size from the encrypted payload (ciphertext) or the
    // plaintext payload fallback. Cheap and good enough for budgeting.
    const bytes = (msg.ciphertext?.length ?? msg.payload?.length ?? 0)
    // RC-8: if this seq is already buffered (a re-record — per-device seqs are
    // monotonic so this is rare, but sendToDevice / heartbeat paths also call
    // record and nothing enforces uniqueness), subtract the prior entry's bytes
    // before adding the new ones. Without this, an overwrite double-counted the
    // old bytes into bytesByDevice, inflating the running total and triggering
    // premature eviction of still-valid frames.
    const prior = buf.get(msg.seq)
    if (prior) {
      this.bytesByDevice.set(deviceId, (this.bytesByDevice.get(deviceId) ?? 0) - prior.bytes)
    }
    buf.set(msg.seq, { msg, bytes })
    this.bytesByDevice.set(deviceId, (this.bytesByDevice.get(deviceId) ?? 0) + bytes)
    this.evict(deviceId, buf)
  }

  /** Evict oldest frames until within both bounds. */
  private evict(deviceId: string, buf: Map<number, { msg: WireMessage; bytes: number }>): void {
    let bytes = this.bytesByDevice.get(deviceId) ?? 0
    while (buf.size > this.maxMessages || bytes > this.maxBytes) {
      const oldestKey = buf.keys().next().value
      if (oldestKey === undefined) break
      const removed = buf.get(oldestKey)
      buf.delete(oldestKey)
      bytes -= removed?.bytes ?? 0
    }
    this.bytesByDevice.set(deviceId, Math.max(0, bytes))
  }

  /**
   * Return the buffered frames for `[fromSeq, toSeq]` (inclusive) in seq order.
   * `complete` is false when any seq in the range is no longer buffered (evicted
   * or never sent), so the caller can tell iOS to fall back to the reconcile.
   */
  range(deviceId: string, fromSeq: number, toSeq: number): { frames: WireMessage[]; complete: boolean } {
    // Validate bounds before any iteration. A non-integer, negative, or inverted
    // range is never satisfiable and — critically — must never drive a loop: a
    // large or bogus toSeq from a peer (iOS seq mismatch after a desktop restart,
    // seq wraparound, or a stale client) would otherwise spin the main thread
    // across billions of empty lookups and freeze the whole app.
    if (
      !Number.isSafeInteger(fromSeq) ||
      !Number.isSafeInteger(toSeq) ||
      fromSeq < 0 ||
      fromSeq > toSeq
    ) {
      warn('retransmit_buffer: invalid resend range', { device_id: deviceId, from_seq: fromSeq, to_seq: toSeq })
      return { frames: [], complete: false }
    }
    const buf = this.byDevice.get(deviceId)
    if (!buf) return { frames: [], complete: false }

    // Iterate the buffered frames (bounded by maxMessages), NOT the integer span
    // [fromSeq, toSeq]. Insertion order is seq-ascending (per-device counters
    // make each device's seqs monotonic and contiguous), so the collected
    // frames come out ordered without a sort.
    const frames: WireMessage[] = []
    for (const [seq, entry] of buf) {
      if (seq >= fromSeq && seq <= toSeq) frames.push(entry.msg)
    }
    // The range is complete only if every seq in [fromSeq, toSeq] was present.
    // This count-vs-span comparison is valid because per-device seqs are
    // contiguous: every seq in the span was once buffered for this device.
    // The span may be astronomically large, but it is a plain subtraction (no
    // loop) and frames.length is bounded by the buffer, so the comparison is O(1)
    // in the span — a huge span simply compares unequal and reports incomplete,
    // letting the caller fall back to the snapshot reconcile.
    const span = toSeq - fromSeq + 1
    const complete = frames.length === span
    return { frames, complete }
  }

  /** Drop all buffered frames for a device (on unpair / disconnect cleanup). */
  clearDevice(deviceId: string): void {
    this.byDevice.delete(deviceId)
    this.bytesByDevice.delete(deviceId)
  }
}

/**
 * Replay the buffered frames for `[fromSeq, toSeq]` to a device by handing each
 * to `deliver`. Returns whether the range was fully covered (every seq present
 * in the buffer). Extracted from RemoteTransport.resend to keep transport.ts
 * within the file-size cap; the transport supplies the per-frame delivery.
 */
export function replayRange(
  buffer: RetransmitBuffer,
  deviceId: string,
  fromSeq: number,
  toSeq: number,
  deliver: (frame: WireMessage) => void,
): boolean {
  const { frames, complete } = buffer.range(deviceId, fromSeq, toSeq)
  for (const frame of frames) deliver(frame)
  return complete
}
