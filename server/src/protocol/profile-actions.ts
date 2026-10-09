/**
 * `profile.capture` -- a CPU profile or heap snapshot of this server process,
 * written under `<data dir>/profiles/`, for an operator chasing a slow or
 * leaking server without restarting it under a debugger.
 *
 * A developer-surface action (`profiling`, `@ion/shared/developer-surfaces`):
 * `actions.ts` refuses it with `surface_disabled` on a connection whose
 * policy switched the surface off, and the refusal is logged there. It also
 * needs the `admin` scope: a profile is the process's memory and call
 * stacks, which no conversation scope covers.
 */
import { captureNodeProfile, type NodeProfileKind } from '@ion/shared/node-profile'
import { dataDir } from '../paths'
import { log as _log, warn as _warn } from '../logger'
import type { MiscActionSpec } from './misc-actions'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('profile-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('profile-actions', msg, fields)
}

function profileKind(value: unknown): NodeProfileKind | null {
  return value === 'cpu' || value === 'heap' ? value : null
}

export const PROFILE_ACTIONS: Record<string, MiscActionSpec> = {
  // [{ kind: 'cpu' | 'heap', seconds? }] -> { kind, path, durationMs, bytes }
  'profile.capture': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      const request = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : {}
      const kind = profileKind(request.kind)
      if (!kind) {
        warn('profile capture refused: kind must be cpu or heap', { connection_id: conn.id, kind: String(request.kind) })
        return { ok: false, error: { code: 'invalid_argument', message: `kind must be 'cpu' or 'heap'` } }
      }
      log('profile capture starting', { connection_id: conn.id, kind, seconds: typeof request.seconds === 'number' ? request.seconds : null, subject: conn.principal?.subject })
      try {
        const result = await captureNodeProfile({ kind, seconds: typeof request.seconds === 'number' ? request.seconds : undefined, dir: dataDir(), processName: 'server' })
        log('profile captured', { connection_id: conn.id, kind, path: result.path, duration_ms: result.durationMs, bytes: result.bytes })
        return { ok: true, value: result }
      } catch (err) {
        warn('profile capture failed', { connection_id: conn.id, kind, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  },
}
