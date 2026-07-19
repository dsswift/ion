// Inbound-epoch tracking for the desktop↔iOS wire, extracted from
// RemoteTransport._handleIncoming (transport.ts) to keep that file under the
// file-size cap, mirroring the transport-dedup.ts extraction pattern.
//
// iOS stamps its TransportManager generation id (WireMessage.epoch, seeded
// from wall-clock ms at instance init) on every outbound frame. The epoch is
// the ONE AND ONLY inbound-dedup reset trigger on the desktop:
//
//  - A frame with a NEWER epoch means iOS built a new TransportManager
//    instance (app restart / re-pair) and its outbound seq space restarted at
//    1 — the dedup state for that device must be reset or every low seq of
//    the new generation drops as "already seen".
//  - A frame with an OLDER epoch is a late frame from a dead iOS generation
//    (old socket draining) and is dropped outright. Processing it would
//    poison the fresh dedup high-water: one stale high-seq frame post-reset
//    re-established the old mark and the dedup then ate every new-generation
//    command as "beyond window" (log-confirmed at transport-dedup.ts drop
//    logging). This is exactly why LAN auth and relay peer-reconnect no
//    longer reset anything — those events don't identify a generation; the
//    epoch does.
//  - A frame with NO epoch (legacy iOS build predating the field, or the
//    pre-auth handshake path) is processed with no epoch logic at all — no
//    reset, no drop — so a mid-upgrade window can't wedge the wire. Logged
//    once per device, not per frame.
//
// Epochs are time-seeded ms and monotonic across iOS generations, which is
// what makes the > / < comparison meaningful.

import { log as _log, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('RemoteTransport', msg, fields)
}

/** Verdict for one inbound frame's epoch, driving RemoteTransport's dispatch. */
export type EpochVerdict =
  /** New iOS generation: caller must reset the inbound dedup, then process. */
  | 'reset'
  /** Late frame from a dead generation: caller must drop the frame. */
  | 'stale'
  /** Same generation (or first-seen, or legacy no-epoch): process normally. */
  | 'ok'

/**
 * Per-device tracker of the last inbound epoch (iOS outbound generation id).
 * See the module header for the full protocol rationale.
 */
export class InboundEpochTracker {
  private lastEpoch = new Map<string, number>() // deviceId -> newest epoch seen
  private legacyLogged = new Set<string>()      // devices logged as epoch-less

  /**
   * Classify one inbound frame's epoch for a device and record it when it
   * advances. `seq` is used only for drop-diagnostics logging.
   */
  check(deviceId: string, epoch: number | undefined, seq: number): EpochVerdict {
    if (epoch === undefined) {
      if (!this.legacyLogged.has(deviceId)) {
        this.legacyLogged.add(deviceId)
        debug('transport: inbound frames carry no epoch (legacy iOS), epoch logic disabled for device', { device_id: deviceId })
      }
      return 'ok'
    }
    const known = this.lastEpoch.get(deviceId)
    if (known === undefined) {
      // First-ever epoch for this device: adopt without a reset.
      this.lastEpoch.set(deviceId, epoch)
      return 'ok'
    }
    if (epoch > known) {
      log('transport: inbound epoch advanced, resetting dedup', { device_id: deviceId, old_epoch: known, new_epoch: epoch })
      this.lastEpoch.set(deviceId, epoch)
      return 'reset'
    }
    if (epoch < known) {
      debug('transport: dropping frame from stale inbound epoch', { device_id: deviceId, seq, stale_epoch: epoch, known_epoch: known })
      return 'stale'
    }
    return 'ok'
  }

  /** Forget a device entirely (unpair / removal). */
  remove(deviceId: string): void {
    this.lastEpoch.delete(deviceId)
    this.legacyLogged.delete(deviceId)
  }

  /** Drop all tracked state (transport stop). */
  clear(): void {
    this.lastEpoch.clear()
    this.legacyLogged.clear()
  }
}
