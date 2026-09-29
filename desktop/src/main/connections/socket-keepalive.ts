/**
 * socket-keepalive -- the liveness check on a socket this desktop opens to a
 * remote environment, directly or through a relay.
 *
 * After a network change the socket can look open while the far end has
 * dropped it. Nothing here sends on an idle connection, so without a ping
 * the broker waits on it forever instead of reconnecting. A dead socket is
 * terminated, and its close runs the broker's reconnect ladder.
 */
import type WebSocket from 'ws'
import { watchSocketLiveness } from '@ion/shared/socket-liveness'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-keepalive', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-keepalive', msg, fields)
}

/** Starts the check when `ws` opens and stops it when it closes. `peer` names the far end in logs; never a secret. */
export function keepSocketAlive(ws: WebSocket, peer: string, intervalMs?: number): WebSocket {
  ws.once('open', () => {
    const stop = watchSocketLiveness(ws, {
      intervalMs,
      onDead: () => warn('peer stopped answering pings; dropping the socket to reconnect', { peer }),
      onPingError: (err) => log('keepalive ping failed', { peer, error: String(err) }),
    })
    ws.once('close', stop)
  })
  return ws
}
