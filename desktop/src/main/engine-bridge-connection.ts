/**
 * EngineBridge connection lifecycle: the connect retry ladder, the socket
 * wiring, and the background reconnect loop. Split from engine-bridge.ts
 * (file-size cap); operates on the bridge instance via the same
 * module-package seam as the other engine-bridge-*.ts siblings.
 *
 * The engine is a persistent launchd daemon — the desktop never spawns it;
 * this module only connects to its socket.
 */
import { createConnection, Socket } from 'net'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log, warn as _warn } from './logger'
import type { EngineBridge } from './engine-bridge'

const TAG = 'EngineBridge'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

const ION_HOME = join(homedir(), '.ion')
export const SOCKET_PATH = join(ION_HOME, 'engine.sock')

/**
 * When ION_DESKTOP_ENGINE_SOCKET is set to "host:port", the bridge connects
 * over TCP to a remote engine instead of spawning a local one. Reconnect on
 * disconnect is automatic with exponential backoff (500 ms → 8 s, then 30 s cap).
 */
export const REMOTE_SOCKET = process.env.ION_DESKTOP_ENGINE_SOCKET || ''
export const IS_REMOTE = REMOTE_SOCKET.includes(':')

/**
 * How long after an exhausted connect retry ladder subsequent connect()
 * callers fail fast (single attempt, no ladder). Past this window a fresh
 * caller runs the full ladder again — covering the case where the outage
 * outlived the window but the daemon is now mid-start.
 */
export const LADDER_FAST_FAIL_WINDOW_MS = 30000

export async function doConnect(bridge: EngineBridge): Promise<void> {
  // Try connecting to the daemon socket directly. The engine is a launchd
  // daemon; the desktop never spawns it. If the socket is not reachable,
  // retry with backoff (launchd may still be starting the daemon after
  // bootstrap/kickstart).
  try {
    await connectSocket(bridge)
    return
  } catch {
    // Socket not ready yet
  }

  // In remote mode we never auto-start, just throw — but keep the
  // background reconnect loop trying, same as the local outage path below.
  if (IS_REMOTE) {
    scheduleReconnect(bridge)
    throw new Error(`Remote engine at ${REMOTE_SOCKET} is not reachable`)
  }

  // Fast-fail during a known outage. Once a full retry ladder has failed,
  // the background reconnect loop owns further attempts — serial callers
  // (e.g. 30 restoring tabs each awaiting connect() before a history load)
  // must NOT each burn the full ladder against a socket that is known dead.
  // One immediate attempt was already made above; that is enough per caller.
  if (bridge.lastLadderFailureAt && Date.now() - bridge.lastLadderFailureAt < LADDER_FAST_FAIL_WINDOW_MS) {
    scheduleReconnect(bridge)
    warn('connect_fast_fail: engine down, reconnect in progress', { socket: SOCKET_PATH })
    throw new Error(`Engine daemon not reachable at ${SOCKET_PATH} (reconnect in progress).`)
  }

  // Retry with backoff. The daemon should already be running via launchd;
  // these retries cover the window between launchctl kickstart and the
  // engine binding the socket.
  const delays = [500, 1000, 2000, 4000]
  for (let i = 0; i < delays.length; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, delays[i]))
    try {
      await connectSocket(bridge)
      return
    } catch {
      if (i < delays.length - 1) {
        log('engine_daemon: not ready, retrying', { delay_ms: delays[i] })
      }
    }
  }
  // The ladder is exhausted: record the outage (arms the fast-fail path
  // above) and hand ongoing recovery to the background reconnect loop —
  // a failed foreground connect must not leave the bridge with nothing
  // retrying in the background.
  bridge.lastLadderFailureAt = Date.now()
  scheduleReconnect(bridge)
  throw new Error(
    `Engine daemon not reachable at ${SOCKET_PATH}. ` +
    'Ensure the Ion Engine LaunchAgent is installed and running ' +
    '(launchctl print gui/${UID}/com.ion.engine).',
  )
}

function connectSocket(bridge: EngineBridge): Promise<void> {
  return new Promise((resolve, reject) => {
    let conn: Socket
    if (IS_REMOTE) {
      const [host, portStr] = REMOTE_SOCKET.split(':')
      const port = parseInt(portStr, 10)
      conn = createConnection({ host, port })
    } else {
      conn = createConnection(SOCKET_PATH)
    }

    conn.on('connect', () => {
      const wasReconnect = bridge.reconnectAttempts > 0
      bridge.conn = conn
      bridge.connected = true
      bridge.reconnectAttempts = 0
      bridge.lastLadderFailureAt = 0
      bridge.buffer = ''
      log('Connected to engine server')
      resolve()
      if (wasReconnect) {
        bridge.emit('reconnected')
        bridge._reRegisterSessions()
      }
    })

    conn.on('data', (chunk: Buffer) => {
      bridge.buffer += chunk.toString()
      bridge._drainBuffer()
    })

    conn.on('close', () => {
      bridge.connected = false
      bridge.conn = null
      log('Disconnected from engine server')
      scheduleReconnect(bridge)
    })

    conn.on('error', (err: NodeJS.ErrnoException) => {
      if (!bridge.connected) {
        warn('connect_err', { code: err.code, socket: REMOTE_SOCKET })
        reject(err)
        return
      }
      // For remote connections, emit a toast-friendly event for transient
      // network errors instead of flooding each chat with error bubbles.
      if (IS_REMOTE && (err.code === 'EHOSTDOWN' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
        warn('remote_engine_unreachable', { code: err.code })
        bridge._failPendingRequests('Remote engine unreachable')
      } else {
        log('connection_error', { error: err.message })
      }
      bridge.connected = false
      bridge.conn = null
      scheduleReconnect(bridge)
    })
  })
}

export function scheduleReconnect(bridge: EngineBridge): void {
  if (bridge.reconnectDisabled) return
  if (bridge.reconnectTimer) return
  if (bridge.connected) return
  bridge.reconnectAttempts++
  const delay = Math.min(500 * Math.pow(2, bridge.reconnectAttempts - 1), IS_REMOTE ? 8000 : 30000)
  log('reconnecting', { delay_ms: delay, attempt: bridge.reconnectAttempts })
  bridge.reconnectTimer = setTimeout(() => {
    void (async () => {
      bridge.reconnectTimer = null
      if (bridge.connected) return
      try {
        await bridge.connect()
      } catch {
        scheduleReconnect(bridge)
      }
    })()
  }, delay)
}
