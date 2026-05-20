/**
 * Git file system watcher.
 *
 * Uses @parcel/watcher (native, recursive on macOS, batched events) to detect
 * changes in a git repository. Two subscriptions per repo:
 *
 * 1. `.git` metadata — HEAD, index, refs, config changes
 * 2. Working tree — file creates/edits/deletes (with .git/node_modules ignored)
 *
 * Trailing-edge debounce at 250 ms to coalesce bursts (e.g. `git pull`
 * touching hundreds of files). When suspended (window blurred), pending events
 * are dropped instead of flushed — on resume the consumer should re-snapshot.
 *
 * Falls back to a no-op when @parcel/watcher isn't available so callers don't
 * need conditionals.
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
  start(repoPath: string, onEvent: (event: GitWatchEvent) => void): void
  stop(): void
  setSuspended(suspended: boolean): void
  readonly active: boolean
  readonly suspended: boolean
}

type Timer = ReturnType<typeof setTimeout>

interface ParcelEvent { path: string; type: string }
interface ParcelSubscription { unsubscribe: () => Promise<void> }
interface ParcelOptions { ignore?: string[] }
export interface ParcelModule {
  subscribe(
    dir: string,
    cb: (err: Error | null, events: ParcelEvent[]) => void,
    opts?: ParcelOptions,
  ): Promise<ParcelSubscription>
}

export function createGitWatcher(parcel?: ParcelModule): GitWatcher {
  let mod: ParcelModule | null = parcel ?? null
  if (!mod) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('@parcel/watcher') as ParcelModule
    } catch {
      log('Git watcher: @parcel/watcher not available, falling back to no-op')
    }
  }

  if (!mod) return createNoOpWatcher()
  return createParcelWatcher(mod)
}

function createNoOpWatcher(): GitWatcher {
  return {
    start: () => { log('Git watcher: no-op (parcel/watcher not available)') },
    stop: () => {},
    setSuspended: () => {},
    get active() { return false },
    get suspended() { return false },
  }
}

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

function createParcelWatcher(pw: ParcelModule): GitWatcher {
  let subscriptions: ParcelSubscription[] = []
  let isActive = false
  let isSuspended = false
  let debounceTimer: Timer | null = null
  let pendingEvents = new Set<GitWatchEvent['kind']>()
  let startGeneration = 0

  return {
    start(repoPath: string, onEvent: (event: GitWatchEvent) => void): void {
      if (isActive) return
      const gen = ++startGeneration

      const flush = (): void => {
        debounceTimer = null
        if (isSuspended) {
          log(`Git watcher flush: suspended, dropping ${pendingEvents.size} events`)
          pendingEvents.clear()
          return
        }
        log(`Git watcher flush: emitting ${pendingEvents.size} events [${[...pendingEvents].join(', ')}]`)
        for (const kind of pendingEvents) onEvent({ kind })
        pendingEvents.clear()
      }

      const scheduleFlush = (): void => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(flush, 250)
      }

      const gitDir = join(repoPath, '.git')

      pw.subscribe(gitDir, (err, events) => {
        if (gen !== startGeneration) return   // stale callback from previous start
        if (err) { log(`Git watcher .git error: ${err.message}`); return }
        for (const event of events) {
          const kind = classifyGitMetaChange(event.path)
          if (kind) pendingEvents.add(kind)
        }
        if (pendingEvents.size > 0) scheduleFlush()
      }).then((sub) => {
        if (gen !== startGeneration) {
          log('Git watcher: unsubscribing stale .git subscription')
          sub.unsubscribe().catch(() => {})
          return
        }
        subscriptions.push(sub)
        log(`Git watcher .git subscription ready: ${repoPath}`)
      }).catch((err: Error) => log(`Git watcher: failed to watch .git: ${err.message}`))

      pw.subscribe(repoPath, (err, events) => {
        if (gen !== startGeneration) return   // stale callback from previous start
        if (err) { log(`Git watcher tree error: ${err.message}`); return }
        if (events.length > 0) {
          pendingEvents.add('status:dirty')
          scheduleFlush()
        }
      }, { ignore: ['.git', 'node_modules', '.DS_Store'] })
        .then((sub) => {
          if (gen !== startGeneration) {
            log('Git watcher: unsubscribing stale tree subscription')
            sub.unsubscribe().catch(() => {})
            return
          }
          subscriptions.push(sub)
          log(`Git watcher tree subscription ready: ${repoPath}`)
        })
        .catch((err: Error) => log(`Git watcher: failed to watch tree: ${err.message}`))

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
      log(`Git watcher stop: unsubscribing ${subscriptions.length} subscriptions`)
      for (const sub of subscriptions) sub.unsubscribe().catch(() => {})
      subscriptions = []
      isActive = false
      startGeneration++  // invalidate any in-flight subscribe callbacks
      log('Git watcher stopped')
    },

    setSuspended(suspended: boolean): void {
      if (isSuspended === suspended) return
      isSuspended = suspended
      log(`Git watcher setSuspended: ${suspended}`)
      if (suspended && debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
        pendingEvents.clear()
      }
    },

    get active() { return isActive },
    get suspended() { return isSuspended },
  }
}
