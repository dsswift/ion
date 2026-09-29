/**
 * The timers that drive the wire-latency measure: a probe to every capable
 * connection, and one window line per connection.
 *
 * Split from `wire-latency.ts` so the meter itself stays a pure counter with
 * no timers or registry of its own -- which is what lets its tests run on a
 * fake clock.
 */
import { randomBytes } from 'crypto'
import { connectionRegistry, type Connection } from './connection'
import { WIRE_PING_CAPABILITY } from '@ion/shared/studio-wire/types'
import { logWireWindow, PING_INTERVAL_MS, WINDOW_INTERVAL_MS } from './wire-latency'
import { log as _log } from '../logger'

const TAG = 'wire-latency'

let pingTimer: ReturnType<typeof setInterval> | null = null
let windowTimer: ReturnType<typeof setInterval> | null = null

/** Who a window line is about. */
function identify(conn: Connection): { clientKind: string; clientId: string; transport: string; connectionId: string } {
  return {
    clientKind: conn.clientKind ?? 'unknown',
    clientId: conn.clientId ?? 'unknown',
    transport: conn.transport,
    connectionId: conn.id,
  }
}

/**
 * Probe one connection.
 *
 * Skips a client that did not advertise `wire-ping`: it would refuse to decode
 * the frame and close the connection, which is a far worse outcome than a
 * missing measurement. A phone on an older build is exactly that client.
 */
export function probeConnection(conn: Connection): boolean {
  if (conn.isClosed || !conn.hasCapability(WIRE_PING_CAPABILITY)) return false
  const nonce = randomBytes(8).toString('hex')
  const now = Date.now()
  conn.latency.recordPingSent(nonce, now)
  return conn.send({ type: 'studio_ping', nonce, t: now })
}

/** Write one connection's window now. Called on the timer, and as a connection closes. */
export function flushConnectionWindow(conn: Connection): void {
  conn.latency.expireStalePings(Date.now())
  logWireWindow(identify(conn), conn.latency)
}

/** Start probing and windowing. Idempotent. */
export function startWireLatency(): void {
  if (pingTimer) return
  pingTimer = setInterval(() => {
    for (const conn of connectionRegistry.all()) probeConnection(conn)
  }, PING_INTERVAL_MS)
  pingTimer.unref?.()

  windowTimer = setInterval(() => {
    for (const conn of connectionRegistry.all()) flushConnectionWindow(conn)
  }, WINDOW_INTERVAL_MS)
  windowTimer.unref?.()

  _log(TAG, 'wire latency measurement started', {
    ping_interval_ms: PING_INTERVAL_MS,
    window_interval_ms: WINDOW_INTERVAL_MS,
  })
}

/** Stop both timers, writing a final window for every live connection first. */
export function stopWireLatency(): void {
  if (!pingTimer && !windowTimer) return
  for (const conn of connectionRegistry.all()) flushConnectionWindow(conn)
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  if (windowTimer) { clearInterval(windowTimer); windowTimer = null }
  _log(TAG, 'wire latency measurement stopped')
}
