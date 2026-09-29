/**
 * tree-watch — tells a subscriber which directories under a root changed.
 *
 * The Explorer used to re-read every open folder on a timer, whether or not
 * anything had changed. This is the signal that replaces the timer: one
 * recursive watch per root, shared by every subscriber of that root, reported
 * as a short list of directories once the burst settles.
 *
 * Subscriptions key on an abstract subscriber (a wire connection), so a
 * connection that closes releases its watches in one call.
 *
 * ── Shape of a notice ────────────────────────────────────────────────────
 * Events coalesce for `TREE_SETTLE_MS` after the last one, and never longer
 * than `TREE_MAX_WAIT_MS` after the first, so a directory under continuous
 * writes still reports. A burst touching more than `TREE_MAX_DIRECTORIES`
 * directories is reported as `overflow` rather than as a list.
 */
import { dirname, relative, sep } from 'path'
import type { FsTreeChange } from '@ion/shared/fs-tree-watch'
import { pathBasename } from '@ion/shared/paths'
import { defaultWatchModule } from '../fs-watch/native-recursive-watch-module'
import type { WatchModule, WatchSubscription } from '../fs-watch/chokidar-watch-module'
import { isValidProjectPath } from '../ipc-validation'
import { log as _log, debug as _debug, warn as _warn } from '../logger'

const TAG = 'tree-watch'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export const TREE_SETTLE_MS = 200
export const TREE_MAX_WAIT_MS = 1_000
export const TREE_MAX_DIRECTORIES = 256

/** Whoever is listening: a wire connection. */
export interface TreeSubscriber {
  /** Stable for the life of the subscriber; scopes the subscription. */
  id: string
  send: (change: FsTreeChange) => void
}

interface RootWatch {
  root: string
  subscribers: Map<string, TreeSubscriber>
  subscription: WatchSubscription | null
  /** Set when the last subscriber left before `subscribe` settled. */
  released: boolean
  directories: Set<string>
  overflow: boolean
  ignoreRulesChanged: boolean
  settleTimer: ReturnType<typeof setTimeout> | null
  maxWaitTimer: ReturnType<typeof setTimeout> | null
  events: number
}

export interface TreeWatchRegistry {
  watch(subscriber: TreeSubscriber, payload: unknown): { ok: boolean; error?: string }
  unwatch(subscriberId: string, payload: unknown): { ok: boolean }
  /** Drop every watch a subscriber holds. Called when a connection closes. */
  unwatchAll(subscriberId: string): void
  /** Roots currently watched. */
  watchedRoots(): string[]
}

function rootOf(payload: unknown): string {
  const root = (payload as { root?: unknown } | null)?.root
  return typeof root === 'string' ? root : ''
}

function isIgnoreRulesFile(relativePath: string): boolean {
  return pathBasename(relativePath) === '.gitignore' || relativePath.endsWith('.git/info/exclude')
}

export function createTreeWatchRegistry(watchModule: WatchModule = defaultWatchModule): TreeWatchRegistry {
  const roots = new Map<string, RootWatch>()

  function clearTimers(entry: RootWatch): void {
    if (entry.settleTimer) clearTimeout(entry.settleTimer)
    if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer)
    entry.settleTimer = null
    entry.maxWaitTimer = null
  }

  function flush(entry: RootWatch): void {
    clearTimers(entry)
    const change: FsTreeChange = {
      root: entry.root,
      directories: entry.overflow ? [] : [...entry.directories],
      overflow: entry.overflow,
      ignoreRulesChanged: entry.ignoreRulesChanged,
    }
    debug('tree changed', {
      root: entry.root,
      directories: change.directories.length,
      overflow: change.overflow,
      ignore_rules_changed: change.ignoreRulesChanged,
      events: entry.events,
      subscribers: entry.subscribers.size,
    })
    entry.directories.clear()
    entry.overflow = false
    entry.ignoreRulesChanged = false
    entry.events = 0
    for (const subscriber of entry.subscribers.values()) subscriber.send(change)
  }

  function schedule(entry: RootWatch): void {
    if (entry.settleTimer) clearTimeout(entry.settleTimer)
    entry.settleTimer = setTimeout(() => flush(entry), TREE_SETTLE_MS)
    entry.maxWaitTimer ??= setTimeout(() => flush(entry), TREE_MAX_WAIT_MS)
  }

  function note(entry: RootWatch, path: string): void {
    entry.events++
    const relativePath = relative(entry.root, path).split(sep).join('/')
    if (relativePath === '..' || relativePath.startsWith('../')) return
    if (isIgnoreRulesFile(relativePath)) entry.ignoreRulesChanged = true
    if (entry.overflow) return
    const parent = dirname(relativePath)
    entry.directories.add(parent === '.' ? '' : parent)
    if (entry.directories.size > TREE_MAX_DIRECTORIES) {
      entry.overflow = true
      entry.directories.clear()
    }
  }

  function start(entry: RootWatch): void {
    watchModule
      .subscribe(entry.root, (err, events) => {
        if (roots.get(entry.root) !== entry) return
        if (err) {
          // A faulted watch may have dropped events, so the subscriber is
          // told to re-read rather than left believing nothing changed.
          warn('watch reported a fault; subscribers will re-read', { root: entry.root, error: err.message })
          entry.overflow = true
          entry.directories.clear()
          schedule(entry)
          return
        }
        for (const event of events) note(entry, event.path)
        if (events.length > 0) schedule(entry)
      }, { resolveType: false })
      .then((subscription) => {
        if (entry.released) {
          debug('watch settled after its last subscriber left; closing it', { root: entry.root })
          subscription.unsubscribe().catch((err: Error) => debug('unsubscribe failed', { root: entry.root, error: String(err) }))
          return
        }
        entry.subscription = subscription
        log('watch ready', { root: entry.root })
      })
      .catch((err: Error) => {
        warn('watch could not start; this root reports no changes', { root: entry.root, error: err.message })
        if (roots.get(entry.root) === entry) roots.delete(entry.root)
      })
  }

  function release(entry: RootWatch): void {
    roots.delete(entry.root)
    entry.released = true
    clearTimers(entry)
    entry.subscription?.unsubscribe().catch((err: Error) => debug('unsubscribe failed', { root: entry.root, error: String(err) }))
    log('watch released', { root: entry.root })
  }

  return {
    watch(subscriber, payload) {
      const root = rootOf(payload)
      if (!isValidProjectPath(root)) {
        warn('watch refused: invalid root', { subscriber: subscriber.id, root })
        return { ok: false, error: 'Invalid path' }
      }
      let entry = roots.get(root)
      if (!entry) {
        entry = {
          root, subscribers: new Map(), subscription: null, released: false,
          directories: new Set(), overflow: false, ignoreRulesChanged: false,
          settleTimer: null, maxWaitTimer: null, events: 0,
        }
        roots.set(root, entry)
        start(entry)
      }
      entry.subscribers.set(subscriber.id, subscriber)
      log('subscribed', { subscriber: subscriber.id, root, subscribers: entry.subscribers.size })
      return { ok: true }
    },

    unwatch(subscriberId, payload) {
      const root = rootOf(payload)
      const entry = roots.get(root)
      if (!entry || !entry.subscribers.delete(subscriberId)) return { ok: true }
      log('unsubscribed', { subscriber: subscriberId, root, subscribers: entry.subscribers.size })
      if (entry.subscribers.size === 0) release(entry)
      return { ok: true }
    },

    unwatchAll(subscriberId) {
      let dropped = 0
      for (const entry of [...roots.values()]) {
        if (!entry.subscribers.delete(subscriberId)) continue
        dropped++
        if (entry.subscribers.size === 0) release(entry)
      }
      if (dropped > 0) log('subscriber gone; released its roots', { subscriber: subscriberId, count: dropped })
    },

    watchedRoots: () => [...roots.keys()],
  }
}

/** The registry every connection shares. */
export const treeWatch: TreeWatchRegistry = createTreeWatchRegistry()
