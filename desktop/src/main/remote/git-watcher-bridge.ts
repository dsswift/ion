/**
 * Git watcher bridge — forwards GitRepository 'event' emissions to connected
 * remote devices via broadcastGitChanges.
 *
 * Lifecycle:
 *   - start(): called when a remote peer connects; retains repos for all
 *     known tab directories and subscribes to their watcher events.
 *   - reconcile(dirs): called each snapshot-polling tick with the current
 *     set of tab working directories; adds/removes retains as tabs change.
 *   - stop(): called when the remote transport tears down; releases all retains.
 */

import { log as _log } from '../logger'
import { repositoryManager } from '../git/repositoryManager'
import { broadcastGitChanges } from './git-broadcast'
import type { GitEvent } from '../../shared/types-git-events'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

interface WatchedEntry {
  listener: (event: GitEvent) => void
}

const watched = new Map<string, WatchedEntry>()
let bridgeActive = false

/** Start the bridge. Retains repos for the given initial directory set. */
export function startGitWatcherBridge(initialDirs: Set<string> = new Set()): void {
  if (bridgeActive) {
    log('git_bridge: already active, reconciling', { watched_count: watched.size })
    reconcileGitWatchedDirectories(initialDirs)
    return
  }
  bridgeActive = true
  log('git_bridge: start', { initial_dirs: initialDirs.size })
  reconcileGitWatchedDirectories(initialDirs)
}

/** Stop the bridge. Releases all retained repos and removes listeners. */
export function stopGitWatcherBridge(): void {
  if (!bridgeActive) {
    log('Git bridge stop: already stopped, no-op')
    return
  }
  const count = watched.size
  log('git_bridge: stop', { active_dirs: count })
  for (const [dir, entry] of watched) {
    const repo = repositoryManager.has(dir) ? repositoryManager.get(dir) : null
    if (repo) {
      repo.off('event', entry.listener)
      log('git_bridge: release', { dir })
      repositoryManager.release(dir)
    }
  }
  watched.clear()
  bridgeActive = false
  log('Git bridge stopped')
}

/**
 * Reconcile the set of watched directories against the provided target set.
 * - New dirs → retain + subscribe + initial broadcast.
 * - Removed dirs → unsubscribe + release.
 * Called by snapshot-polling on each tick.
 */
export function reconcileGitWatchedDirectories(directories: Set<string>): void {
  if (!bridgeActive) return

  const current = new Set(watched.keys())
  const added: string[] = []
  const removed: string[] = []

  for (const dir of directories) {
    if (!current.has(dir) && dir) {
      added.push(dir)
    }
  }

  for (const dir of current) {
    if (!directories.has(dir)) {
      removed.push(dir)
    }
  }

  if (added.length === 0 && removed.length === 0) return

  log('git_bridge: reconcile', { added: added.length, removed: removed.length, active: watched.size + added.length - removed.length })

  for (const dir of added) {
    const listener = (_event: GitEvent): void => {
      log('git_bridge: broadcast', { dir, trigger: 'watcher' })
      broadcastGitChanges(dir).catch((err: Error) =>
        log('git_bridge: broadcast error', { dir, error: err.message })
      )
    }
    const repo = repositoryManager.retain(dir)
    log('git_bridge: retain', { dir, ref_count: repo.refCount })
    repo.on('event', listener)
    watched.set(dir, { listener })
    // Initial push so freshly connected devices get state immediately
    log('git_bridge: broadcast', { dir, trigger: 'initial' })
    broadcastGitChanges(dir).catch((err: Error) =>
      log('git_bridge: broadcast error initial', { dir, error: err.message })
    )
  }

  for (const dir of removed) {
    const entry = watched.get(dir)
    if (entry) {
      const repo = repositoryManager.has(dir) ? repositoryManager.get(dir) : null
      if (repo) {
        repo.off('event', entry.listener)
        repositoryManager.release(dir)
        log('git_bridge: release', { dir, ref_count: repo.refCount })
      }
      watched.delete(dir)
    }
  }
}
