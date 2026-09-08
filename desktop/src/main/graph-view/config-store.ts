/**
 * Graph View configuration disk store: per-project cache, `.ion` directory
 * watch, and cache invalidation.
 *
 * Watches the DIRECTORY, not the file: the file may not exist yet at the
 * time watching starts, and an editor's atomic save (write temp, rename)
 * replaces the inode a plain file watch is bound to. `desktop/src/main/ipc/
 * files.ts` FS_WATCH_FILE watches single files for that surface; this store
 * needs the create-and-rename case too, so it watches the parent directory
 * and filters on the `settings.json` filename.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { log as _log, debug as _debug, warn as _warn } from '../logger'
import { readSettings } from '../settings-store'
import { broadcast } from '../broadcast'
import { IPC } from '../../shared/types-ipc'
import { resolveGraphViewConfig } from './config-resolve'
import type { GraphViewConfig } from '../../shared/graph-view-types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

const DEBOUNCE_MS = 250

function projectSettingsPath(projectPath: string): string {
  return join(projectPath, '.ion', 'settings.json')
}

/** Read the raw project settings file. Never throws; mirrors `readSettings()`. */
export function readProjectFile(projectPath: string): Record<string, unknown> {
  const filePath = projectSettingsPath(projectPath)
  if (!existsSync(filePath)) {
    debug('graph_view: no project settings file', { projectPath })
    return {}
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    warn('graph_view: project settings file failed to parse', { projectPath, error: String(err) })
    return {}
  }
}

interface CacheEntry {
  config: GraphViewConfig
}

interface WatchEntry {
  refCount: number
  watcher: FSWatcher
  watchedDir: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const configCache = new Map<string, CacheEntry>()
const watchers = new Map<string, WatchEntry>()
const configChangeListeners = new Set<(projectPath: string, config: GraphViewConfig) => void>()

/**
 * Register a callback fired whenever a project's resolved config changes
 * (either a direct `.ion/settings.json` edit or a user-scope write).
 * `corpus-store.ts` (child 03) uses this to reconfigure its watch set
 * without `config-store.ts` importing it directly.
 */
export function onGraphViewConfigChanged(callback: (projectPath: string, config: GraphViewConfig) => void): () => void {
  configChangeListeners.add(callback)
  return () => configChangeListeners.delete(callback)
}

function notifyConfigChanged(projectPath: string, config: GraphViewConfig): void {
  for (const listener of configChangeListeners) listener(projectPath, config)
}

/** Resolve and cache the config for a project path. Cache hit returns without re-reading disk. */
export function getGraphViewConfig(projectPath: string): GraphViewConfig {
  const cached = configCache.get(projectPath)
  if (cached) return cached.config

  const config = resolveGraphViewConfig(readSettings(), readProjectFile(projectPath), projectPath)
  configCache.set(projectPath, { config })
  return config
}

/** Clear every cached config. Used after a user-scope write. */
export function invalidateAllGraphViewConfig(): void {
  configCache.clear()
}

function invalidateProject(projectPath: string): void {
  configCache.delete(projectPath)
}

/**
 * Start watching `<projectPath>/.ion` for changes to `settings.json`.
 * Ref-counted: repeated calls for the same project increment a counter
 * rather than creating a second watcher.
 */
export function watchProject(projectPath: string): void {
  const existing = watchers.get(projectPath)
  if (existing) {
    existing.refCount++
    return
  }

  const dir = join(projectPath, '.ion')
  const parentDir = projectPath
  const initialDir = existsSync(dir) ? dir : parentDir

  try {
    const handleSettingsEvent = (_eventType: string, filename: string | Buffer | null): void => {
      if (filename?.toString() !== 'settings.json') return
      const entry = watchers.get(projectPath)
      if (!entry) return
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null
        invalidateProject(projectPath)
        const config = getGraphViewConfig(projectPath)
        broadcast(IPC.GRAPH_VIEW_CONFIG_CHANGED, projectPath, config)
        notifyConfigChanged(projectPath, config)
        log('graph_view: config changed, broadcast', { projectPath, rootCount: config.corpusRoots.length })
      }, DEBOUNCE_MS)
    }
    const watcher = watch(initialDir, (eventType, filename) => {
      const entry = watchers.get(projectPath)
      if (!entry) return
      if (entry.watchedDir === parentDir && filename?.toString() === '.ion' && existsSync(dir)) {
        entry.watcher.close()
        try {
          entry.watcher = watch(dir, handleSettingsEvent)
          entry.watchedDir = dir
          handleSettingsEvent('rename', 'settings.json')
          debug('graph_view: project settings directory appeared, watch promoted', { projectPath })
        } catch (err) {
          warn('graph_view: failed to promote project settings watcher', { projectPath, error: String(err) })
        }
        return
      }
      handleSettingsEvent(eventType, filename)
    })
    watcher.on('error', (err) => {
      warn('graph_view: project settings watcher error', { projectPath, error: String(err) })
      const entry = watchers.get(projectPath)
      if (entry) {
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        entry.watcher.close()
        watchers.delete(projectPath)
      }
    })
    watchers.set(projectPath, { refCount: 1, watcher, watchedDir: initialDir, debounceTimer: null })
    debug('graph_view: watching project settings directory', { projectPath, watchedDir: initialDir })
  } catch (err) {
    warn('graph_view: failed to watch project settings directory', { projectPath, error: String(err) })
  }
}

/** Release one reference on a project's watch; closes the watcher at zero. */
export function unwatchProject(projectPath: string): void {
  const entry = watchers.get(projectPath)
  if (!entry) return
  entry.refCount--
  if (entry.refCount <= 0) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.watcher.close()
    watchers.delete(projectPath)
  }
}

/**
 * Clear the whole cache and re-broadcast `GRAPH_VIEW_CONFIG_CHANGED` for
 * every watched project. Called after a successful
 * `GRAPH_VIEW_SET_USER_CONFIG` write, since a user-scope change affects
 * every open project at once and there is no per-project renderer-facing
 * `ion:settings-changed` main hook to key off of.
 */
export function invalidateAndBroadcastAll(): void {
  invalidateAllGraphViewConfig()
  for (const projectPath of watchers.keys()) {
    const config = getGraphViewConfig(projectPath)
    broadcast(IPC.GRAPH_VIEW_CONFIG_CHANGED, projectPath, config)
    notifyConfigChanged(projectPath, config)
  }
  log('graph_view: user config changed, broadcast to all watched projects', { projectCount: watchers.size })
}

/** Test-only: reset all module state between test cases. */
export function _resetGraphViewConfigStoreForTest(): void {
  for (const entry of watchers.values()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.watcher.close()
  }
  watchers.clear()
  configCache.clear()
}
