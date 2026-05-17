/**
 * Git file system watcher.
 *
 * Uses @parcel/watcher (native, recursive on macOS, batched events) to detect
 * changes in a git repository. Two subscriptions per repo:
 *
 * 1. `.git` metadata — HEAD, index, refs, config changes
 * 2. Working tree — file creates/edits/deletes (filtered by .gitignore)
 *
 * Gated by the `gitWatcher` feature flag. When unavailable or disabled,
 * exports a no-op implementation so callers don't need conditionals.
 *
 * Trailing-edge debounce at 250ms to coalesce bursts (e.g. `git pull`
 * touching hundreds of files).
 */

import { join } from 'path'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('main', msg)
}

export type GitWatchEvent =
  | { kind: 'status:dirty' }
  | { kind: 'head:changed' }
  | { kind: 'refs:dirty' }
  | { kind: 'config:dirty' }

export interface GitWatcher {
  /** Start watching. Calls `onEvent` when git-relevant changes are detected. */
  start(repoPath: string, onEvent: (event: GitWatchEvent) => void): void
  /** Stop watching and clean up. */
  stop(): void
  /** Whether the watcher is currently active. */
  readonly active: boolean
}

/** Debounce timer ID type. */
type Timer = ReturnType<typeof setTimeout>

/**
 * Create a watcher that attempts to use @parcel/watcher.
 * Falls back to a no-op if the native module isn't available.
 */
export function createGitWatcher(): GitWatcher {
  let parcelWatcher: any = null
  try {
    // Dynamic require — @parcel/watcher is a native module that may not be installed
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    parcelWatcher = require('@parcel/watcher')
  } catch {
    log('Git watcher: @parcel/watcher not available, falling back to no-op')
  }

  if (!parcelWatcher) {
    return createNoOpWatcher()
  }

  return createParcelWatcher(parcelWatcher)
}

function createNoOpWatcher(): GitWatcher {
  return {
    start: () => { log('Git watcher: no-op (parcel/watcher not available)') },
    stop: () => {},
    get active() { return false },
  }
}

function createParcelWatcher(pw: any): GitWatcher {
  let subscriptions: Array<{ unsubscribe: () => Promise<void> }> = []
  let isActive = false
  let debounceTimer: Timer | null = null
  let pendingEvents = new Set<GitWatchEvent['kind']>()

  const GIT_META_FILES = new Set([
    'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD',
    'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'index', 'packed-refs', 'config',
  ])

  function classifyGitMetaChange(path: string): GitWatchEvent['kind'] | null {
    const basename = path.split('/').pop() || ''
    if (basename === 'HEAD' || basename === 'MERGE_HEAD' ||
        basename === 'CHERRY_PICK_HEAD' || basename === 'REBASE_HEAD') {
      return 'head:changed'
    }
    if (basename === 'config') return 'config:dirty'
    if (basename === 'index' || basename === 'packed-refs') return 'status:dirty'
    if (path.includes('/refs/')) return 'refs:dirty'
    if (GIT_META_FILES.has(basename)) return 'status:dirty'
    return null
  }

  return {
    start(repoPath: string, onEvent: (event: GitWatchEvent) => void): void {
      if (isActive) return

      const flush = (): void => {
        debounceTimer = null
        for (const kind of pendingEvents) {
          onEvent({ kind })
        }
        pendingEvents.clear()
      }

      const scheduleFlush = (): void => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(flush, 250)
      }

      const gitDir = join(repoPath, '.git')

      // Subscribe to .git metadata
      pw.subscribe(gitDir, (err: Error | null, events: Array<{ path: string; type: string }>) => {
        if (err) { log(`Git watcher .git error: ${err.message}`); return }
        for (const event of events) {
          const kind = classifyGitMetaChange(event.path)
          if (kind) {
            pendingEvents.add(kind)
          }
        }
        if (pendingEvents.size > 0) scheduleFlush()
      }).then((sub: { unsubscribe: () => Promise<void> }) => {
        subscriptions.push(sub)
      }).catch((err: Error) => {
        log(`Git watcher: failed to watch .git: ${err.message}`)
      })

      // Subscribe to working tree
      pw.subscribe(repoPath, (err: Error | null, events: Array<{ path: string; type: string }>) => {
        if (err) { log(`Git watcher tree error: ${err.message}`); return }
        if (events.length > 0) {
          pendingEvents.add('status:dirty')
          scheduleFlush()
        }
      }, {
        ignore: ['.git', 'node_modules', '.DS_Store'],
      }).then((sub: { unsubscribe: () => Promise<void> }) => {
        subscriptions.push(sub)
      }).catch((err: Error) => {
        log(`Git watcher: failed to watch tree: ${err.message}`)
      })

      isActive = true
      log(`Git watcher started: ${repoPath}`)
    },

    stop(): void {
      if (!isActive) return
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      pendingEvents.clear()
      for (const sub of subscriptions) {
        sub.unsubscribe().catch(() => {})
      }
      subscriptions = []
      isActive = false
      log('Git watcher stopped')
    },

    get active() { return isActive },
  }
}
