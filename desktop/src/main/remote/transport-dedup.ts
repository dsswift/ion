// Windowed inbound dedup for the desktop↔iOS wire, extracted from
// RemoteTransport._handleIncoming (transport.ts) to keep that file under the
// file-size cap, mirroring the transport-send.ts extraction pattern.
//
// Why a window instead of a strict high-water mark: iOS fires commands from
// concurrent Tasks, so wire order is not seq order, and during relay→LAN
// transitions late frames can still arrive from the old socket. A strict
// "drop anything <= lastReceivedSeq" mark silently ate real out-of-order
// commands (load_conversation, prompts, tab create, terminal input) whenever a
// higher seq happened to arrive first. This tracker accepts any DISTINCT seq
// within a sliding window behind the high-water mark and drops only genuine
// duplicates (or seqs so old they fell out of the window).

import { log as _log, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('RemoteTransport', msg, fields)
}

/**
 * How far behind the high-water mark an out-of-order seq may arrive and still
 * be accepted. Anything at or beyond this distance is dropped as stale — it
 * predates the window and cannot be distinguished from a replay.
 */
export const DEDUP_WINDOW = 512

/**
 * Per-device reorder-tolerant inbound dedup.
 *
 * Accept rules for a frame with sequence number `seq`:
 *  - seq > highWater: accept, advance the mark (a jump > 1 is logged as a gap
 *    for diagnostics — with concurrent iOS senders the "gap" usually fills in
 *    a moment later with the out-of-order frames).
 *  - highWater - DEDUP_WINDOW < seq <= highWater and not seen before: accept
 *    (late/out-of-order arrival within the window).
 *  - already seen, or at/beyond the window edge: drop.
 *
 * `reset` starts a new inbound-seq generation for a device. The ONLY caller is
 * the inbound-epoch check in RemoteTransport._handleIncoming: iOS keeps its
 * outbound seq continuous for the life of one TransportManager instance and
 * stamps that instance's epoch on every frame, so a NEWER epoch — not a LAN
 * auth, not a relay peer reconnect — is the signal that the seq space
 * restarted. `reset` must clear the seen-set too, or one stale high-seq frame
 * from the previous generation poisons the mark and the new generation's low
 * seqs are all dropped.
 */
export class InboundDedup {
  private highWater = new Map<string, number>() // deviceId -> highest accepted seq
  private seen = new Map<string, Set<number>>() // deviceId -> seqs accepted within the window

  /** Decide whether to accept an inbound frame; records the seq when accepted. */
  shouldAccept(deviceId: string, seq: number): boolean {
    const hw = this.highWater.get(deviceId) ?? 0
    let seenSet = this.seen.get(deviceId)
    if (!seenSet) {
      seenSet = new Set()
      this.seen.set(deviceId, seenSet)
    }

    if (seq > hw) {
      // Forward progress. A jump of more than one is a (possibly transient)
      // gap — the missing seqs may still arrive out of order and be accepted
      // through the window below.
      if (seq > hw + 1) {
        log('transport: seq gap', { device_id: deviceId, expected: hw + 1, got: seq })
      }
      this.highWater.set(deviceId, seq)
      seenSet.add(seq)
      // Prune seqs that fell out of the window so the set stays bounded.
      const floor = seq - DEDUP_WINDOW
      for (const s of seenSet) {
        if (s <= floor) seenSet.delete(s)
      }
      return true
    }

    if (seq <= hw - DEDUP_WINDOW) {
      debug('transport: dedup dropping msg beyond window', { device_id: deviceId, seq, high_water: hw })
      return false
    }

    if (seenSet.has(seq)) {
      debug('transport: dedup dropping duplicate msg', { device_id: deviceId, seq, high_water: hw })
      return false
    }

    // Out-of-order but distinct and within the window: a real frame that
    // arrived late (concurrent iOS Tasks / transport switch). Accept it.
    debug('transport: accepting out-of-order msg within window', { device_id: deviceId, seq, high_water: hw })
    seenSet.add(seq)
    return true
  }

  /** Start a new inbound-seq generation for a device. Sole trigger: a NEWER
   *  inbound WireMessage.epoch (see RemoteTransport._handleIncoming). */
  reset(deviceId: string): void {
    this.highWater.set(deviceId, 0)
    this.seen.get(deviceId)?.clear()
  }

  /** Forget a device entirely (unpair / removal). */
  remove(deviceId: string): void {
    this.highWater.delete(deviceId)
    this.seen.delete(deviceId)
  }

  /** Drop all tracked state (transport stop). */
  clear(): void {
    this.highWater.clear()
    this.seen.clear()
  }
}
