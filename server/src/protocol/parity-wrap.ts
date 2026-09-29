/**
 * parity-wrap -- what every parity action is built from: the handler wrapper
 * that turns a declined argument into `invalid_argument` and a thrown
 * implementation into `action_failed`, and the argument readers.
 *
 * Its own module so `parity-actions.ts` and `parity-client-actions.ts` can
 * both build on it without importing each other.
 */
import { log as _log, warn as _warn } from '../logger'
import type { Scope } from '@ion/shared/studio-wire/types'
import type { Connection } from './connection'
import type { SessionActionSpec } from './session-actions'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('parity-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('parity-actions', msg, fields)
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
export const tabAt = (a: unknown[]): string | undefined => str(obj(a[0]).tabId) || undefined

/** A request the action understood and declined: a bad argument, not a crash. */
export class Declined extends Error {}

export function wrap(name: string, requiredScope: Scope, run: (args: Record<string, unknown>, conn: Connection) => unknown | Promise<unknown>, tabIdAt?: (args: unknown[]) => string | undefined): SessionActionSpec {
  return {
    requiredScope,
    ...(tabIdAt ? { tabIdAt } : {}),
    handler: async (conn, args) => {
      try {
        const value = (await run(obj(args[0]), conn)) ?? null
        log('parity action ran', { connection_id: conn.id, action: name })
        return { ok: true, value }
      } catch (err) {
        if (err instanceof Declined) {
          log('parity action declined', { connection_id: conn.id, action: name, reason: err.message })
          return { ok: false, error: { code: 'invalid_argument', message: err.message } }
        }
        warn('parity action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

/** The id a connection's per-client state is kept under: its pairing, else the id it said hello with. */
export function clientKey(conn: Connection): string {
  return conn.pairedClientId ?? conn.clientId ?? conn.id
}

export function requireTab(a: Record<string, unknown>): string {
  const tabId = str(a.tabId)
  if (!tabId) throw new Declined('tabId is required')
  return tabId
}
