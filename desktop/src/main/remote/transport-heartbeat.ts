// Heartbeat sender for RemoteTransport, extracted from transport.ts.
//
// Lifted out of the RemoteTransport class to keep transport.ts under the
// file-size cap, following the same ctx-based helper pattern as
// transport-lan-auth.ts and transport-send.ts: the functions operate on an
// explicit HeartbeatCtx rather than `this`, so the timer lifecycle and the
// per-device send stay testable in isolation.
//
// The desktop emits one heartbeat frame per paired device every
// HEARTBEAT_INTERVAL_MS. iOS keys its LAN liveness watchdog off LAN-delivered
// heartbeats (a relay-delivered heartbeat proves only the relay works), so the
// cadence must be steady for the watchdog's two-interval starvation threshold
// to be meaningful.

import { log as _log } from '../logger'
import type { RemoteEvent } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

/**
 * The transport state the heartbeat path touches. Passed explicitly so the
 * functions are pure with respect to the transport instance.
 *   - deviceSecrets: deviceId → shared secret for every PAIRED device; the key
 *     set defines who receives a heartbeat.
 *   - seqs: per-device outbound seq counters. Used as `(seqs.get(deviceId) ?? 0) + 1`
 *     to build the heartbeat payload's `seq` field — a pre-drain prediction of
 *     the next outbound counter, NOT the authoritative wire seq (which is
 *     allocated during the drain itself). iOS reads only ts/buffered from
 *     heartbeats; the payload seq is informational and may differ from the
 *     wire-envelope seq by at most a few frames.
 *   - queuedCount: current send-queue depth, surfaced to iOS as `buffered`.
 *   - sendToDevice: the transport's single-device send (routes through the
 *     ordered drain when the crypto worker is live, sendDirect otherwise).
 *   - intervalMs: heartbeat cadence.
 */
export interface HeartbeatCtx {
  deviceSecrets: Map<string, Buffer>
  seqs: Map<string, number>
  queuedCount: () => number
  sendToDevice: (deviceId: string, event: RemoteEvent) => void
  intervalMs: number
}

/**
 * Send one heartbeat frame to a single device.
 *
 * The payload `seq` field is informational only — iOS reads just ts/buffered
 * from a heartbeat and keys ordering/dedup off the WIRE-envelope seq (allocated
 * during the send, not this payload field). The payload value is a best-effort
 * prediction of that device's next outbound counter; it is not consumed as a
 * guarantee. Like every other sendToDevice call, a heartbeat routes through the
 * ordered send-queue drain when the crypto worker is live (so it cannot deliver
 * ahead of an in-flight lower-seq worker frame) and through the synchronous
 * sendDirect fallback otherwise.
 *
 * Also invoked directly when a LAN client completes auth (via the transport's
 * onAuthenticated hook) so a re-authenticated socket carries proof of life
 * immediately instead of after up to one full interval.
 */
export function sendHeartbeatTo(ctx: HeartbeatCtx, deviceId: string): void {
  const ts = Date.now()
  const buffered = ctx.queuedCount()
  ctx.sendToDevice(deviceId, { type: 'desktop_heartbeat', seq: (ctx.seqs.get(deviceId) ?? 0) + 1, ts, buffered })
}

/**
 * One heartbeat frame to every paired device, plus a single INFO line for
 * observability (the sender was previously log-silent, making it impossible to
 * confirm from desktop.jsonl that heartbeats were flowing at all).
 */
export function sendHeartbeatsTick(ctx: HeartbeatCtx): void {
  for (const deviceId of ctx.deviceSecrets.keys()) {
    sendHeartbeatTo(ctx, deviceId)
  }
  log('transport: heartbeat sent', { devices: ctx.deviceSecrets.size, buffered: ctx.queuedCount() })
}

/**
 * Start the heartbeat interval. Returns the timer handle for the caller to
 * store and later pass to stopHeartbeat. Idempotency (no double-start) is the
 * caller's responsibility — the transport calls stopHeartbeat first.
 */
export function startHeartbeat(ctx: HeartbeatCtx): ReturnType<typeof setInterval> {
  log('transport: heartbeat started', { interval_ms: ctx.intervalMs, devices: ctx.deviceSecrets.size })
  return setInterval(() => sendHeartbeatsTick(ctx), ctx.intervalMs)
}

/** Clear the heartbeat interval if one is running. Returns null for the caller
 *  to reassign to its timer field. */
export function stopHeartbeat(timer: ReturnType<typeof setInterval> | null): null {
  if (timer) {
    clearInterval(timer)
    log('transport: heartbeat stopped')
  }
  return null
}
