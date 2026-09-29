/**
 * client-log-request -- asking a thin client for the diagnostic log lines it
 * has written since the cursor the server holds for it.
 *
 * A client's own log is the only record of what it did, and it lives on the
 * client. The server asks on `studio:client-log-request` with `{sinceSeq}`;
 * the client answers by calling `clientLog.append`, which persists the lines
 * and the new cursor (`remote/handlers/diagnostics.ts`). Asking again with an
 * unchanged cursor is harmless: lines at or below it are dropped on arrival.
 *
 * The server asks when a thin connection gets its first paint, and then on
 * an interval while any thin connection is attached.
 */
import { CLIENT_LOG_REQUEST_CHANNEL } from '@ion/shared/studio-wire/channels'
import { diagnosticLogCursor, PERIODIC_LOG_PULL_INTERVAL_MS } from '../remote/handlers/diagnostics'
import { clientKey } from '../protocol/parity-wrap'
import type { Connection } from '../protocol/connection'
import { thinConnections } from './remote-out'
import { log as _log, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('thin-view', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('thin-view', msg, fields)
}

let interval: ReturnType<typeof setInterval> | null = null

/** Ask one thin connection for its log lines past the persisted cursor. */
export function requestClientLogs(conn: Connection): boolean {
  if (conn.isClosed || conn.view !== 'thin') return false
  const sinceSeq = diagnosticLogCursor(clientKey(conn))
  debug('client log requested', { connection_id: conn.id, since_seq: sinceSeq })
  return conn.send({ type: 'studio_event', channel: CLIENT_LOG_REQUEST_CHANNEL, payload: { sinceSeq } })
}

/** Start asking every attached thin connection on the pull interval. Idempotent; stops itself when none remain. */
export function startClientLogRequests(): void {
  if (interval) return
  log('client log requests started', { interval_ms: PERIODIC_LOG_PULL_INTERVAL_MS })
  interval = setInterval(() => {
    const conns = thinConnections()
    if (conns.length === 0) {
      stopClientLogRequests()
      return
    }
    for (const conn of conns) requestClientLogs(conn)
  }, PERIODIC_LOG_PULL_INTERVAL_MS)
  interval.unref?.()
}

export function stopClientLogRequests(): void {
  if (!interval) return
  clearInterval(interval)
  interval = null
  log('client log requests stopped: no thin connection attached')
}
