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

function log(msg: string): void {
  _log('main', msg)
}

interface WatchedEntry {
  listener: (event: GitEvent) => void
}

const watched = new Map<string, WatchedEntry>()
let bridgeActive = false

/** Start the bridge. Retains repos for the given initial directory set. */
export function startGitWatcherBridge(initialDirs: Set<string> = new Set()): void {
  if (bridgeActive) {
    log(`Git bridge already active (${watched.size} active dirs) — reconciling with new dirs`)
    reconcileGitWatchedDirectories(initialDirs)
    return
  }
  bridgeActive = true
  log(`Git bridge start: initialDirs=${initialDirs.size}`)
  reconcileGitWatchedDirectories(initialDirs)
}

/** Stop the bridge. Releases all retained repos and removes listeners. */
export function stopGitWatcherBridge(): void {
  if (!bridgeActive) {
    log('Git bridge stop: already stopped, no-op')
    return
  }
  const count = watched.size
  log(`Git bridge stop: releasing ${count} active dirs`)
  for (const [dir, entry] of watched) {
    const repo = repositoryManager.has(dir) ? repositoryManager.get(dir) : null
    if (repo) {
      repo.off('event', entry.listener)
      log(`Git bridge release: ${dir}`)
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

  log(`Git bridge reconcile: +${added.length} added, -${removed.length} removed, ${watched.size + added.length - removed.length} active`)

  for (const dir of added) {
    const listener = (_event: GitEvent): void => {
      log(`Git bridge broadcast: ${dir} (trigger=watcher)`)
      broadcastGitChanges(dir).catch((err: Error) =>
        log(`Git bridge broadcast error for ${dir}: ${err.message}`)
      )
    }
    const repo = repositoryManager.retain(dir)
    log(`Git bridge retain: ${dir} (refCount=${repo.refCount})`)
    repo.on('event', listener)
    watched.set(dir, { listener })
    // Initial push so freshly connected devices get state immediately
    log(`Git bridge broadcast: ${dir} (trigger=initial)`)
    broadcastGitChanges(dir).catch((err: Error) =>
      log(`Git bridge broadcast error (initial) for ${dir}: ${err.message}`)
    )
  }

  for (const dir of removed) {
    const entry = watched.get(dir)
    if (entry) {
      const repo = repositoryManager.has(dir) ? repositoryManager.get(dir) : null
      if (repo) {
        repo.off('event', entry.listener)
        repositoryManager.release(dir)
        log(`Git bridge release: ${dir} (refCount=${repo.refCount})`)
      }
      watched.delete(dir)
    }
  }
}
