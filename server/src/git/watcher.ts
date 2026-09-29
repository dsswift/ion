/**
 * Git file system watcher.
 *
 * Backed by `fs-watch/chokidar-watch-module.ts` (see that file for why it
 * replaced @parcel/watcher) to detect changes in a git repository. Two
 * subscriptions per repo:
 *
 * 1. `.git` metadata — HEAD, index, refs, config changes
 * 2. Working tree — file creates/edits/deletes (with .git/node_modules ignored)
 *
 * Trailing-edge debounce at 250 ms to coalesce bursts (e.g. `git pull`
 * touching hundreds of files). When suspended (window blurred), pending events
 * are dropped instead of flushed — on resume the consumer should re-snapshot.
 *
 * Falls back to a no-op when the watch module isn't available so callers
 * don't need conditionals.
 */

import { join } from 'path'
import { log as _log, debug as _debug } from '../logger'
import { defaultWatchModule } from '../fs-watch/native-recursive-watch-module'
import { pathBasename } from '@ion/shared/paths'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
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

export interface WatchEvent { path: string; type: string }
export interface WatchSubscription { unsubscribe: () => Promise<void> }
export interface WatchOptions { ignore?: string[] }
export interface WatchModule {
  subscribe(
    dir: string,
    cb: (err: Error | null, events: WatchEvent[]) => void,
    opts?: WatchOptions,
  ): Promise<WatchSubscription>
}

/**
 * Resolve the real watch module: an injected fake wins (tests), `null`
 * (passed explicitly) forces the no-op watcher (also tests), and omitting
 * the argument uses the real implementation: one recursive `fs.watch` per
 * root (`fs-watch/native-recursive-watch-module.ts`), which chokidar backs
 * only where the platform cannot recurse. A per-file chokidar watch over a
 * whole checkout once held ~8,000 descriptors and made every git spawn fail
 * with EBADF. Both are bundled JavaScript with no native binary to be
 * missing, so there is no failure branch to guard here.
 */
export function resolveWatchModule(injected?: WatchModule | null): WatchModule | null {
  return injected === undefined ? defaultWatchModule : injected
}

export function createGitWatcher(watchModule?: WatchModule | null): GitWatcher {
  const mod = resolveWatchModule(watchModule)
  if (!mod) {
    log('Git watcher: no watch module available, falling back to no-op')
    return createNoOpWatcher()
  }
  return createSubscriptionWatcher(mod)
}

function createNoOpWatcher(): GitWatcher {
  return {
    start: () => { log('Git watcher: no-op (watch module not available)') },
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

/**
 * Classifies a raw filesystem-watcher path into the git-metadata change kind
 * it represents. rawPath is normalized to forward slashes first: the watch
 * module delivers backslash-separated paths on Windows, and every check below
 * (basename split, `/refs/` substring) assumes '/' — without the
 * normalization every event on Windows would misclassify as null and the
 * git panel would never refresh.
 */
export function classifyGitMetaChange(rawPath: string): GitWatchEvent['kind'] | null {
  const path = rawPath.replaceAll('\\', '/')
  const basename = pathBasename(path)
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

function createSubscriptionWatcher(watchModule: WatchModule): GitWatcher {
  let subscriptions: WatchSubscription[] = []
  let isActive = false
  let isSuspended = false
  let debounceTimer: Timer | null = null
  const pendingEvents = new Set<GitWatchEvent['kind']>()
  let startGeneration = 0
  let heartbeatTimer: Timer | null = null
  let currentRepoPath = ''
  let lastEventAt = 0
  let totalEventsSeen = 0

  return {
    start(repoPath: string, onEvent: (event: GitWatchEvent) => void): void {
      if (isActive) return
      const gen = ++startGeneration
      currentRepoPath = repoPath
      lastEventAt = Date.now()
      totalEventsSeen = 0

      const flush = (): void => {
        debounceTimer = null
        if (isSuspended) {
          log('git_watcher: flush suspended, dropping', { count: pendingEvents.size })
          pendingEvents.clear()
          return
        }
        log('git_watcher: flush emitting', { count: pendingEvents.size })
        for (const kind of pendingEvents) onEvent({ kind })
        pendingEvents.clear()
      }

      const scheduleFlush = (): void => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(flush, 250)
      }

      const gitDir = join(repoPath, '.git')

      watchModule.subscribe(gitDir, (err, events) => {
        if (gen !== startGeneration) return   // stale callback from previous start
        if (err) { log('git_watcher: .git error', { error: err.message }); return }
        lastEventAt = Date.now()
        totalEventsSeen += events.length
        for (const event of events) {
          const kind = classifyGitMetaChange(event.path)
          if (kind) pendingEvents.add(kind)
        }
        if (pendingEvents.size > 0) scheduleFlush()
      }).then((sub) => {
        if (gen !== startGeneration) {
          log('Git watcher: unsubscribing stale .git subscription')
          sub.unsubscribe().catch((err: Error) => debug("git_watcher: unsubscribe failed", { error: String(err) }))
          return
        }
        subscriptions.push(sub)
        log('git_watcher: .git subscription ready', { path: repoPath })
      }).catch((err: Error) => log('git_watcher: failed to watch .git', { error: err.message }))

      watchModule.subscribe(repoPath, (err, events) => {
        if (gen !== startGeneration) return   // stale callback from previous start
        if (err) { log('git_watcher: tree error', { error: err.message }); return }
        lastEventAt = Date.now()
        totalEventsSeen += events.length
        if (events.length > 0) {
          pendingEvents.add('status:dirty')
          scheduleFlush()
        }
      }, { ignore: ['.git', 'node_modules', '.DS_Store'] })
        .then((sub) => {
          if (gen !== startGeneration) {
            log('Git watcher: unsubscribing stale tree subscription')
            sub.unsubscribe().catch((err: Error) => debug("git_watcher: unsubscribe failed", { error: String(err) }))
            return
          }
          subscriptions.push(sub)
          log('git_watcher: tree subscription ready', { path: repoPath })
        })
        .catch((err: Error) => log('git_watcher: failed to watch tree', { error: err.message }))

      // Heartbeat — log every 60 s while active so future investigations
      // can compare watcher liveness against the moment the renderer stopped
      // seeing updates. Pure observability; no behavior change.
      heartbeatTimer = setInterval(() => {
        const ageSec = Math.round((Date.now() - lastEventAt) / 1000)
        log('git_watcher: heartbeat', { path: currentRepoPath, subs: subscriptions.length, suspended: isSuspended, events_seen: totalEventsSeen, last_age_s: ageSec })
      }, 60_000)

      isActive = true
      log('git_watcher: started', { path: repoPath })
    },

    stop(): void {
      if (!isActive) return
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      pendingEvents.clear()
      log('git_watcher: stopping', { path: currentRepoPath, subs: subscriptions.length, events_seen: totalEventsSeen })
      for (const sub of subscriptions) sub.unsubscribe().catch((err: Error) => debug("git_watcher: unsubscribe failed", { error: String(err) }))
      subscriptions = []
      isActive = false
      startGeneration++  // invalidate any in-flight subscribe callbacks
      log('Git watcher stopped')
    },

    setSuspended(suspended: boolean): void {
      if (isSuspended === suspended) return
      isSuspended = suspended
      log('git_watcher: setSuspended', { suspended })
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
