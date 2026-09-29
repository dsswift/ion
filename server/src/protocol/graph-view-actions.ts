/**
 * `graphView.*` `studio_action`s: the Graph View's configuration and corpus
 * reads, moved from the desktop's `ipc/graph-view.ts`.
 *
 * The config resolves per project directory (`graph-view/config-store.ts`),
 * the corpus is a reference-counted directory scan with a file watcher
 * (`graph-view/corpus-store.ts`), and both push their changes on the
 * `ion:graph-view-config-changed` / `ion:graph-corpus-delta` channels. A
 * reference taken here is recorded against the calling connection
 * (`graph-view/corpus-subscriptions.ts`) so a dropped socket releases it.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Reads and the corpus subscription are `conversations:read`. Writing the
 * user's Graph View configuration persists into the environment's
 * `settings.json` for every client, so it is `conversations:operate`.
 */
import { GRAPH_VIEW_PROJECT_FIELDS, isGraphViewAvailable, type GraphViewConfig } from '@ion/shared/graph-view-types'
import { isValidProjectPath } from '../ipc-validation'
import { readSettings } from '../persistence/settings-store'
import { persistAndBroadcastSettings } from '../settings-broadcast'
import { getGraphViewConfig, invalidateAndBroadcastAll } from '../graph-view/config-store'
import { resolveGraphViewConfig } from '../graph-view/config-resolve'
import { subscribeCorpusFor, unsubscribeCorpusFor } from '../graph-view/corpus-subscriptions'
import { log as _log, warn as _warn } from '../logger'
import type { MiscActionSpec } from './misc-actions'
import type { Connection } from './connection'
import type { Scope } from '@ion/shared/studio-wire/types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('graph-view-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('graph-view-actions', msg, fields)
}

function wrap(name: string, requiredScope: Scope, run: (conn: Connection, args: unknown[]) => unknown | Promise<unknown>): MiscActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(conn, args)) ?? null }
      } catch (err) {
        warn('graph view action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

/** The rejected-invalid-path shape: no project directory, so no default root. */
function defaultShapedConfig(): GraphViewConfig {
  return resolveGraphViewConfig({}, {}, '')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function projectPathArg(args: unknown[]): string | null {
  const v = args[0]
  return typeof v === 'string' && isValidProjectPath(v) ? v : null
}

export const GRAPH_VIEW_ACTIONS: Record<string, MiscActionSpec> = {
  // [projectPath] → GraphViewConfig. An invalid path resolves to the empty
  // shape rather than an error, matching the IPC handler it replaces: the
  // "+" menu probes availability with this and simply omits the entry.
  'graphView.getConfig': wrap('graphView.getConfig', 'conversations:read', (_conn, a) => {
    const projectPath = projectPathArg(a)
    if (!projectPath) {
      warn('graph_view: get config rejected invalid path', { projectPath: String(a[0]).slice(0, 64) })
      return defaultShapedConfig()
    }
    const config = getGraphViewConfig(projectPath)
    if (isGraphViewAvailable(config)) {
      log('graph_view: availability resolved', { projectPath, available: true, rootCount: config.corpusRoots.length })
    } else {
      log('graph_view: availability resolved', { projectPath, available: false, reason: 'no-corpus-roots' })
    }
    return config
  }),

  // [patch] → { ok, error? }. Only the user-writable project fields are
  // accepted; the merge lands in `settings.json` under `desktop.graphView`.
  'graphView.setUserConfig': wrap('graphView.setUserConfig', 'conversations:operate', (_conn, a) => {
    const patch = a[0]
    if (!isPlainObject(patch)) {
      warn('graph_view: set user config rejected non-object patch')
      return { ok: false, error: 'Patch must be an object' }
    }
    const allowed = new Set<string>(GRAPH_VIEW_PROJECT_FIELDS)
    const invalidKeys = Object.keys(patch).filter((k) => !allowed.has(k))
    if (invalidKeys.length > 0) {
      warn('graph_view: set user config rejected disallowed keys', { keys: invalidKeys.join(',') })
      return { ok: false, error: `Disallowed keys: ${invalidKeys.join(', ')}` }
    }

    const prev = readSettings()
    const prevDesktop = isPlainObject(prev.desktop) ? prev.desktop : {}
    const prevGraphView = isPlainObject(prevDesktop.graphView) ? prevDesktop.graphView : {}
    const next = { ...prev, desktop: { ...prevDesktop, graphView: { ...prevGraphView, ...patch } } }

    try {
      persistAndBroadcastSettings(next, prev)
    } catch (err) {
      warn('graph_view: set user config write failed', { error: String(err) })
      return { ok: false, error: String(err) }
    }

    invalidateAndBroadcastAll()
    log('graph_view: user config written', { keys: Object.keys(patch).join(',') })
    return { ok: true }
  }),

  // [projectPath] → CorpusSnapshot. The reference is held by this connection.
  'graphView.corpusSubscribe': wrap('graphView.corpusSubscribe', 'conversations:read', async (conn, a) => {
    const projectPath = projectPathArg(a)
    if (!projectPath) {
      warn('graph_view: corpus subscribe rejected invalid path', { connection_id: conn.id, projectPath: String(a[0]).slice(0, 64) })
      return { revision: 0, roots: [], documents: [] }
    }
    const snapshot = await subscribeCorpusFor(conn.id, projectPath)
    log('graph_view: corpus subscribed', { connection_id: conn.id, projectPath, revision: snapshot.revision, documentCount: snapshot.documents.length })
    return snapshot
  }),

  // [projectPath] → { ok: true }.
  'graphView.corpusUnsubscribe': wrap('graphView.corpusUnsubscribe', 'conversations:read', (conn, a) => {
    const projectPath = projectPathArg(a)
    if (!projectPath) return { ok: true }
    unsubscribeCorpusFor(conn.id, projectPath)
    log('graph_view: corpus unsubscribed', { connection_id: conn.id, projectPath })
    return { ok: true }
  }),
}
