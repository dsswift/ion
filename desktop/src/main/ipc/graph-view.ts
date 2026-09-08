/**
 * Graph View IPC handlers.
 *
 * Registers `GRAPH_VIEW_GET_CONFIG` and `GRAPH_VIEW_SET_USER_CONFIG` (child
 * 01). Corpus subscribe/unsubscribe channels are added by child 02; the
 * live-watch delta channel by child 03. All three children extend
 * `registerGraphViewIpc()` in place rather than registering a second
 * handler set.
 */

import { ipcMain } from 'electron'
import { IPC } from '../../shared/types-ipc'
import { isValidProjectPath } from '../ipc-validation'
import { log as _log, warn as _warn } from '../logger'
import { readSettings } from '../settings-store'
import { persistAndBroadcastSettings } from '../settings-broadcast'
import {
  getGraphViewConfig,
  invalidateAndBroadcastAll,
} from '../graph-view/config-store'
import { resolveGraphViewConfig } from '../graph-view/config-resolve'
import { GRAPH_VIEW_PROJECT_FIELDS, isGraphViewAvailable, type GraphViewConfig } from '../../shared/graph-view-types'
import { subscribeCorpus, unsubscribeCorpus } from '../graph-view/corpus-store'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/** The rejected-invalid-path shape: no project directory, so no default root. */
function defaultShapedConfig(): GraphViewConfig {
  return resolveGraphViewConfig({}, {}, '')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function projectPathFromEnvelope(envelope: unknown): string | null {
  if (!isPlainObject(envelope) || typeof envelope.projectPath !== 'string') return null
  return envelope.projectPath
}

export function registerGraphViewIpc(): void {
  ipcMain.handle(IPC.GRAPH_VIEW_GET_CONFIG, async (_event, envelope: unknown) => {
    const projectPath = projectPathFromEnvelope(envelope)
    if (!projectPath || !isValidProjectPath(projectPath)) {
      warn('graph_view: get config rejected invalid path', { projectPath: String(projectPath).slice(0, 64) })
      return defaultShapedConfig()
    }
    const config = getGraphViewConfig(projectPath)
    if (isGraphViewAvailable(config)) {
      log('graph_view: availability resolved', { projectPath, available: true, rootCount: config.corpusRoots.length })
    } else {
      log('graph_view: availability resolved', { projectPath, available: false, reason: 'no-corpus-roots' })
    }
    return config
  })

  ipcMain.handle(IPC.GRAPH_VIEW_SET_USER_CONFIG, async (_event, envelope: unknown) => {
    const patch = isPlainObject(envelope) ? envelope.patch : undefined
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
    const next = {
      ...prev,
      desktop: {
        ...prevDesktop,
        graphView: {
          ...prevGraphView,
          ...patch,
        },
      },
    }

    try {
      persistAndBroadcastSettings(next, prev)
    } catch (err) {
      warn('graph_view: set user config write failed', { error: String(err) })
      return { ok: false, error: String(err) }
    }

    invalidateAndBroadcastAll()
    log('graph_view: user config written', { keys: Object.keys(patch).join(',') })
    return { ok: true }
  })

  ipcMain.handle(IPC.GRAPH_CORPUS_SUBSCRIBE, async (_event, envelope: unknown) => {
    const projectPath = projectPathFromEnvelope(envelope)
    if (!projectPath || !isValidProjectPath(projectPath)) {
      warn('graph_view: corpus subscribe rejected invalid path', { projectPath: String(projectPath).slice(0, 64) })
      return { revision: 0, roots: [], documents: [] }
    }
    return subscribeCorpus(projectPath)
  })

  ipcMain.handle(IPC.GRAPH_CORPUS_UNSUBSCRIBE, async (_event, envelope: unknown) => {
    const projectPath = projectPathFromEnvelope(envelope)
    if (!projectPath || !isValidProjectPath(projectPath)) return { ok: true }
    unsubscribeCorpus(projectPath)
    return { ok: true }
  })
}
