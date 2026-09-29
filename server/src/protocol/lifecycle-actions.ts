/**
 * `lifecycle.*` `studio_action`s: what the local desktop and its server tell
 * each other about the process pair they form.
 *
 * The Electron main process is the one party that hears `powerMonitor` and
 * the one that shows a quit dialog; the server is the one party that owns
 * the relay sockets, the stall watchdog, the engine sessions and every
 * background job a shutdown must stop. These verbs carry the signal across
 * that boundary. All are `admin` and refused unless the caller is the local
 * desktop: a remote client has no standing to suspend, or stop, an
 * Environment it is visiting.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Scope } from '@ion/shared/studio-wire/types'
import { log as _log, warn as _warn, flushLogs } from '../logger'
import { sessionPlane } from '../state'
import { dataDir } from '../paths'
import { setWatchdogSuspended } from '../watchdog'
import { renewRelayClientsAfterWake } from '../remote/relay-client'
import { runServerShutdown } from '../shutdown'
import type { MiscActionSpec } from './misc-actions'
import type { Connection } from './connection'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('lifecycle-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('lifecycle-actions', msg, fields)
}

export function isLocalDesktop(conn: Connection): boolean {
  return conn.transport === 'local' && conn.clientKind === 'desktop'
}

function wrap(name: string, requiredScope: Scope, run: (conn: Connection, args: unknown[]) => unknown | Promise<unknown>): MiscActionSpec {
  return {
    requiredScope,
    localOnly: true,
    handler: async (conn, args) => {
      if (!isLocalDesktop(conn)) {
        warn('refused: local desktop only', { connection_id: conn.id, action: name, transport: conn.transport, client_kind: conn.clientKind })
        return { ok: false, error: { code: 'local_only', message: `${name} is only available to the local desktop` } }
      }
      try {
        return { ok: true, value: (await run(conn, args)) ?? null }
      } catch (err) {
        warn('lifecycle action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

/** How the process ends after `lifecycle.shutdown` has replied. A seam so the harness can assert the reply arrives first. */
let exitAfterShutdown: (code: number) => void = (code) => process.exit(code)
/** TEST ONLY. */
export function _setExitAfterShutdownForTest(fn: ((code: number) => void) | null): void {
  exitAfterShutdown = fn ?? ((code) => process.exit(code))
}

/** The last hundred lines of this server's own log, for the diagnostics view. */
function recentLogTail(): { logPath: string; recentLogs: string } {
  const logPath = join(dataDir(), 'server.jsonl')
  if (!existsSync(logPath)) return { logPath, recentLogs: '' }
  try {
    return { logPath, recentLogs: readFileSync(logPath, 'utf-8').split('\n').slice(-100).join('\n') }
  } catch (err) {
    warn('diagnostics log tail read failed', { error: String(err) })
    return { logPath, recentLogs: '' }
  }
}

export const LIFECYCLE_ACTIONS: Record<string, MiscActionSpec> = {
  // What the quit dialog says: are engine sessions running right now?
  'lifecycle.status': wrap('lifecycle.status', 'admin', () => ({ hasRunningTabs: sessionPlane.hasRunningTabs() })),

  // The desktop's quit, carried out here where the sessions, PTYs, transport
  // and background jobs live. Replies `ok` once the sequence has run, THEN
  // closes the listeners and exits, so the desktop's wait is bounded by a
  // reply it can observe rather than by a child exit it has to guess at.
  'lifecycle.shutdown': wrap('lifecycle.shutdown', 'admin', async (conn, a) => {
    const opts = (a[0] ?? {}) as { stopSessions?: unknown }
    const stopSessions = opts.stopSessions === true
    log('shutdown requested by the local desktop', { connection_id: conn.id, stop_sessions: stopSessions })
    await runServerShutdown({ stopSessions, reason: `lifecycle.shutdown from ${conn.id}` })
    setImmediate(() => {
      log('exiting after shutdown reply')
      // This line and the exit are the same tick, so without the drain it was
      // the one line guaranteed never to reach the file.
      flushLogs()
      exitAfterShutdown(0)
    })
    return { ok: true }
  }),

  'lifecycle.diagnostics': wrap('lifecycle.diagnostics', 'admin', () => ({ health: sessionPlane.getHealth(), ...recentLogTail() })),


  'lifecycle.systemSuspend': wrap('lifecycle.systemSuspend', 'admin', () => {
    setWatchdogSuspended(true)
    log('watchdog paused for system suspend')
    return null
  }),
  'lifecycle.systemWake': wrap('lifecycle.systemWake', 'admin', () => {
    setWatchdogSuspended(false)
    log('watchdog resumed after system wake')
    // A relay socket does not survive the host sleeping: it must redial, or
    // a phone on the relay stays unreachable until something else forces it.
    const renewed = renewRelayClientsAfterWake()
    log('relay sockets renewed after system wake', { relay_client_count: renewed })
    return null
  }),
}
