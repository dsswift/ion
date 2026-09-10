/**
 * EngineBridge connection lifecycle: the connect retry ladder, the socket
 * wiring, and the background reconnect loop. Split from engine-bridge.ts
 * (file-size cap); operates on the bridge instance via the same
 * module-package seam as the other engine-bridge-*.ts siblings.
 *
 * The engine is a persistent daemon (a launchd LaunchAgent on macOS, a
 * per-user Scheduled Task on Windows) — the desktop never spawns it; this
 * module only connects to its address.
 */
import { Socket } from 'net'
import { log as _log, warn as _warn } from './logger'
import { resolveEngineAddress, describeEngineAddress, connectToEngine, supervisorHint } from './engine-address'
import type { EngineBridge } from './engine-bridge'

const TAG = 'EngineBridge'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** The resolved local engine address (unix socket, or TCP loopback on win32). */
export const ENGINE_ADDRESS = resolveEngineAddress()

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

/**
 * How many background reconnect attempts must fail before the supervisor is
 * asked to bring the engine back. Low enough that a dead daemon is recovered
 * in seconds, high enough that the ordinary case -- the engine still binding
 * its address after a start -- is covered by plain reconnects.
 */
export const SUPERVISOR_REASSERT_AFTER_ATTEMPTS = 3

/** Minimum gap between two supervisor re-assertions during one outage. */
export const SUPERVISOR_REASSERT_COOLDOWN_MS = 30000

/**
 * When each bridge last asked the supervisor to bring the engine back. Held
 * here rather than on the bridge because re-asserting is entirely this
 * module's concern -- the same reason reconnectAttempts is documented as
 * package-internal.
 */
const lastSupervisorReassertAt = new WeakMap<EngineBridge, number>()

export async function doConnect(bridge: EngineBridge): Promise<void> {
  if (bridge.reconnectDisabled) {
    throw new Error('Engine bridge connection is disabled during teardown.')
  }

  // Try connecting to the daemon socket directly. The engine is a launchd
  // daemon; the desktop never spawns it. If the socket is not reachable,
  // retry with backoff (launchd may still be starting the daemon after
  // bootstrap/kickstart).
  try {
    await connectSocket(bridge)
    return
  } catch (err) {
    if (bridge.reconnectDisabled) {
      throw err
    }
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
    warn('connect_fast_fail: engine down, reconnect in progress', { socket: describeEngineAddress(ENGINE_ADDRESS) })
    throw new Error(`Engine daemon not reachable at ${describeEngineAddress(ENGINE_ADDRESS)} (reconnect in progress).`)
  }

  // Retry with backoff. The daemon should already be running via the
  // supervisor (launchd on macOS, a Scheduled Task on Windows); these
  // retries cover the window between supervisor start and the engine
  // binding its address.
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
    `Engine daemon not reachable at ${describeEngineAddress(ENGINE_ADDRESS)}. ` +
    `Ensure the Ion Engine supervisor is running (${supervisorHint()}).`,
  )
}

function connectSocket(bridge: EngineBridge): Promise<void> {
  return new Promise((resolve, reject) => {
    let conn: Socket
    if (IS_REMOTE) {
      const [host, portStr] = REMOTE_SOCKET.split(':')
      const port = parseInt(portStr, 10)
      conn = connectToEngine({ kind: 'tcp', host, port })
    } else {
      conn = connectToEngine(ENGINE_ADDRESS)
    }

    conn.on('connect', () => {
      if (bridge.reconnectDisabled) {
        // disconnect can run while a socket is still connecting. Never publish
        // that late connection onto a bridge that teardown already retired.
        conn.destroy()
        reject(new Error('Engine bridge connection was stopped during connect.'))
        return
      }

      const wasReconnect = bridge.reconnectAttempts > 0
      bridge.conn = conn
      bridge.connected = true
      bridge.reconnectAttempts = 0
      bridge.lastLadderFailureAt = 0
      bridge.consecutiveTimeouts = 0
      bridge._reRegisterGeneration++
      bridge.buffer = ''
      log('Connected to engine server')
      resolve()
      if (wasReconnect) {
        // Deferred interrupts go out FIRST: an aborted key must be retired
        // before re-registration can restart it (see flushPendingAborts).
        bridge.flushPendingAborts()
        bridge.emit('reconnected')
        bridge._reRegisterSessions()
      }
    })

    conn.on('data', (chunk: Buffer) => {
      bridge.buffer += chunk.toString()
      bridge._drainBuffer()
    })

    conn.on('close', () => {
      if (bridge.conn !== conn) return
      bridge.connected = false
      bridge.conn = null
      log('Disconnected from engine server')
      bridge._failPendingRequests('Connection closed')
      scheduleReconnect(bridge)
    })

    conn.on('error', (err: NodeJS.ErrnoException) => {
      if (!bridge.connected) {
        warn('connect_err', { code: err.code, socket: REMOTE_SOCKET })
        reject(err)
        return
      }
      if (bridge.conn !== conn) return
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

/**
 * Ask the supervisor to bring the engine back when reconnecting alone is not
 * going to work.
 *
 * Reconnecting assumes the daemon is running and only its address is not up
 * yet. That assumption breaks whenever the daemon is genuinely gone, and
 * nothing else re-asserts it: startup asks the supervisor exactly once, and a
 * `schtasks /Run` is a no-op while a task is still running, so a start issued
 * during the previous daemon's shutdown does nothing and the readiness probe
 * can be answered by the outgoing process. Both instances then exit and the
 * reconnect loop retries a socket that no one is ever going to bind.
 *
 * Re-asserting is rate-limited rather than done on every tick: the supervisor
 * call shells out, and a genuinely slow start should not be interrupted by a
 * second one.
 */
async function reassertSupervisorIfStale(bridge: EngineBridge): Promise<void> {
  if (IS_REMOTE) return
  if (bridge.reconnectAttempts < SUPERVISOR_REASSERT_AFTER_ATTEMPTS) return
  const last = lastSupervisorReassertAt.get(bridge)
  if (last !== undefined && Date.now() - last < SUPERVISOR_REASSERT_COOLDOWN_MS) {
    log('engine_daemon: supervisor re-assert skipped, still in cooldown', { since_ms: Date.now() - last })
    return
  }
  lastSupervisorReassertAt.set(bridge, Date.now())
  log('engine_daemon: reconnect is not recovering, re-asserting the supervisor', {
    attempts: bridge.reconnectAttempts,
  })
  try {
    // Imported lazily so the bootstrap module -- which reaches child_process,
    // the supervisors and the installed-binary layout -- stays out of the
    // static graph of every module that merely opens a socket.
    const { restartEngineDaemon } = await import('./engine-bootstrap')
    const ok = await restartEngineDaemon()
    log('engine_daemon: supervisor re-assert finished', { restarted: ok })
  } catch (err) {
    warn('engine_daemon: supervisor re-assert failed', { error: String(err) })
  }
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
      if (bridge.reconnectDisabled || bridge.connected) return
      await reassertSupervisorIfStale(bridge)
      try {
        await bridge.connect()
      } catch {
        scheduleReconnect(bridge)
      }
    })()
  }, delay)
}
