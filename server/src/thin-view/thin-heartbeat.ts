/**
 * thin-heartbeat -- the signal a thin client measures its link by.
 *
 * A phone on a relay has no other way to tell a healthy connection from one
 * that is technically open and delivering nothing. It measures the link by
 * timing these: each carries the server's clock reading, and the client's
 * meter reads the median round trip across a small rolling window, degrading
 * to nothing when the newest sample goes stale.
 *
 * This is NOT the connection liveness ping in `protocol/listener.ts`. That
 * one is a WebSocket ping every 30 seconds whose job is to drop a socket an
 * intermediary killed without a close frame; it carries no payload a client
 * can time, and its interval is deliberately tuned to idle timeouts at
 * proxies rather than to anything a person looks at.
 *
 * The interval here is tuned to the meter instead. The client reads a sample
 * older than 45 seconds as no signal and older than 15 as degraded, so a
 * 30-second beat would park a perfectly good relay link at the bottom of the
 * scale between beats. Ten seconds keeps a healthy link in the top band and
 * still reports a genuinely dead one within a window the meter recognises.
 *
 * `desktop_heartbeat` outlived the `desktop_*` transport that used to emit
 * it: the payload type and the client's meter both survived the wire's
 * deletion while its only producer did not, so the meter sat at "No Signal"
 * on a working connection.
 */
import { thinConnections, sendThinEventTo } from './remote-out'
import type { Connection } from '../protocol/connection'
import { log as _log, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('thin-view', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('thin-view', msg, fields)
}

/**
 * How often a thin client is given something to time.
 *
 * Bounded by the client meter's own staleness thresholds (15s degraded, 45s
 * no signal), not by proxy idle timeouts -- the liveness ping already covers
 * those and runs on its own schedule.
 */
export const THIN_HEARTBEAT_INTERVAL_MS = 10_000

let interval: ReturnType<typeof setInterval> | null = null
let seq = 0

/**
 * Send one heartbeat to one thin connection.
 *
 * `buffered` is this connection's own queue depth, so a client whose link is
 * backing up can say so rather than only reporting latency. Returns whether
 * the frame was written.
 */
export function sendThinHeartbeat(conn: Connection): boolean {
  return sendThinEventTo(conn, {
    type: 'desktop_heartbeat',
    seq: ++seq,
    ts: Date.now(),
    buffered: conn.buffer.size,
  })
}

/** Start beating to every attached thin connection. Idempotent; stops itself when none remain. */
export function startThinHeartbeat(): void {
  if (interval) return
  log('thin heartbeat started', { interval_ms: THIN_HEARTBEAT_INTERVAL_MS })
  interval = setInterval(() => {
    const conns = thinConnections()
    if (conns.length === 0) {
      stopThinHeartbeat()
      return
    }
    let sent = 0
    for (const conn of conns) if (sendThinHeartbeat(conn)) sent++
    debug('thin heartbeat sent', { connection_count: sent, thin_connections: conns.length })
  }, THIN_HEARTBEAT_INTERVAL_MS)
  interval.unref?.()
}

export function stopThinHeartbeat(): void {
  if (!interval) return
  clearInterval(interval)
  interval = null
  log('thin heartbeat stopped: no thin connection attached')
}

/** TEST ONLY: forget the interval and the sequence. */
export function _resetThinHeartbeatForTest(): void {
  if (interval) clearInterval(interval)
  interval = null
  seq = 0
}
