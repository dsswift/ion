/**
 * `engine.*` / `plugin.*` `studio_action`s: the engine passthroughs that have
 * no store action, moved from the desktop's `ipc/engine.ts`.
 *
 * The lifecycle verbs a client reaches through the store (start, abort,
 * rewind, fork, plan mode, permission mode) are FORWARDED store actions and
 * stay there. These are the remainder: one-line delegates onto
 * `store/host-api-engine.ts`, the same functions the store itself calls, so
 * neither transport owns the behavior.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Everything that steers a live session is `conversations:operate` and
 * tab-owned (`tabIdAt`): a session key IS the tab id (ADR-010), so the
 * ownership check in `actions.ts` applies. Plugin management changes what
 * the whole Environment can do and is `admin`.
 */
import { engineBridge } from '../state'
import {
  engineAbortDispatch,
  engineBranchBefore,
  engineBroadcastHistory,
  engineDialogResponse,
  engineRemapSession,
  engineStop,
  engineStopBackgroundTask,
} from '../store/host-api-engine'
import { log as _log, warn as _warn } from '../logger'
import type { Scope } from '@ion/shared/studio-wire/types'
import type { SessionActionSpec } from './session-actions'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('engine-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('engine-actions', msg, fields)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

function wrap(name: string, requiredScope: Scope, run: (args: unknown[]) => unknown | Promise<unknown>, tabIdAt?: (args: unknown[]) => string | undefined): SessionActionSpec {
  return {
    requiredScope,
    ...(tabIdAt ? { tabIdAt } : {}),
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(args)) ?? null }
      } catch (err) {
        warn('engine action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

const keyAt = (a: unknown[]): string | undefined => str(obj(a[0]).key) || undefined

export const ENGINE_ACTIONS: Record<string, SessionActionSpec> = {
  // [{ key, dispatchId }]
  'engine.abortDispatch': wrap('engine.abortDispatch', 'conversations:operate', (a) => {
    const p = obj(a[0])
    return engineAbortDispatch(str(p.key), str(p.dispatchId))
  }, keyAt),
  // [{ key, taskId }] → { ok, error?, status? }
  'engine.stopBackgroundTask': wrap('engine.stopBackgroundTask', 'conversations:operate', (a) => {
    const p = obj(a[0])
    return engineStopBackgroundTask(str(p.key), str(p.taskId))
  }, keyAt),
  // [{ key, dialogId, value }]
  'engine.dialogResponse': wrap('engine.dialogResponse', 'conversations:operate', (a) => {
    const p = obj(a[0])
    log('engine_dialog_response', { key: str(p.key), dialog_id: str(p.dialogId) })
    return engineDialogResponse(str(p.key), str(p.dialogId), p.value)
  }, keyAt),
  // [{ key }] -- a Guided Questions workflow deliberately survives this: the
  // question is parked, not running, so there is nothing to stop.
  'engine.stop': wrap('engine.stop', 'conversations:operate', (a) => {
    const key = str(obj(a[0]).key)
    log('engine_stop', { key })
    return engineStop(key)
  }, keyAt),
  // [{ key, entryId }]
  'engine.branchBefore': wrap('engine.branchBefore', 'conversations:operate', (a) => {
    const p = obj(a[0])
    return engineBranchBefore(str(p.key), str(p.entryId))
  }, keyAt),
  // [{ oldKey, newKey }] -- owned by the session being moved.
  'engine.remapSession': wrap('engine.remapSession', 'conversations:operate', (a) => {
    const p = obj(a[0])
    engineRemapSession(str(p.oldKey), str(p.newKey))
    return null
  }, (a) => str(obj(a[0]).oldKey) || undefined),
  // [{ tabId, instanceId, opts? }]
  'engine.broadcastHistory': wrap('engine.broadcastHistory', 'conversations:operate', (a) => {
    const p = obj(a[0])
    const instanceId = typeof p.instanceId === 'string' ? p.instanceId : null
    return engineBroadcastHistory(str(p.tabId), instanceId, obj(p.opts) as { queueUntilTabExists?: boolean })
  }, (a) => str(obj(a[0]).tabId) || undefined),

  // ── Plugin management ──
  // [source]
  'plugin.install': wrap('plugin.install', 'admin', (a) => {
    log('plugin_install', { source: str(a[0]) })
    return engineBridge.request('plugin_install', { source: str(a[0]) })
  }),
  'plugin.list': wrap('plugin.list', 'admin', () => {
    log('plugin_list')
    return engineBridge.request('plugin_list', {})
  }),
  // [name]
  'plugin.remove': wrap('plugin.remove', 'admin', (a) => {
    log('plugin_remove', { name: str(a[0]) })
    return engineBridge.request('plugin_remove', { label: str(a[0]) })
  }),
}
