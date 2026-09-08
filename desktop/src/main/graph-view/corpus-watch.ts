/**
 * Corpus live watch: one `@parcel/watcher` subscription per configured
 * root, coalesced on a 250 ms trailing debounce into one flush per project.
 *
 * Follows the pattern of `main/git/watcher.ts` (not imported — its event
 * vocabulary is git-specific): the same `try { require(...) } catch` guard
 * with a no-op fallback, the same injectable `ParcelModule` interface for
 * tests, and the same debounce figure.
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { log as _log, debug as _debug, warn as _warn } from '../logger'
import type { CorpusRootConfig } from '../../shared/graph-view-types'
import type { CorpusRootWatchState } from '../../shared/graph-corpus-types'

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
const IGNORE = ['**/.git/**', '**/node_modules/**']

export interface ParcelEvent {
  path: string
  type: string
}
export interface ParcelSubscription {
  unsubscribe(): Promise<void>
}
export interface ParcelOptions {
  ignore?: string[]
}
export interface ParcelModule {
  subscribe(
    dir: string,
    cb: (err: Error | null, events: ParcelEvent[]) => void,
    opts?: ParcelOptions,
  ): Promise<ParcelSubscription>
}

export interface CorpusWatcherCallbacks {
  /** Expanded absolute `.md` paths this window touched (created, updated, or the caller must resolve deletion). */
  onFlush(paths: Set<string>): void
  /** Every currently-known document path under `directoryPath` (a deleted directory's cached members). */
  getKnownPathsUnderPrefix(directoryPath: string): string[]
  /**
   * One root's live-watch outcome: `watching` once its subscription resolves,
   * `failed` when the subscribe rejects or the watcher reports a runtime
   * error. A root that is missing on disk is never reported — a missing root
   * is silently ignored by design, not a degraded one.
   */
  onRootWatchState(rootPath: string, state: CorpusRootWatchState, reason: string): void
}

export interface CorpusWatcher {
  /** Subscribe to every existing root for a project. */
  start(projectPath: string, roots: CorpusRootConfig[], callbacks: CorpusWatcherCallbacks): void
  /** Diff the root set against what's currently subscribed and adjust. */
  reconfigure(projectPath: string, roots: CorpusRootConfig[]): void
  stop(projectPath: string): void
  readonly available: boolean
}

/**
 * Resolve the `@parcel/watcher` module: the injected fake wins (tests), else
 * a real `require`, else `null` on failure (native module unavailable).
 * Exported so a test can exercise the failure branch directly without
 * needing to mock Node's `require` machinery.
 */
export function resolveParcelModule(injected?: ParcelModule | null, requireFn?: (id: string) => unknown): ParcelModule | null {
  if (injected) return injected
  try {
    const req = requireFn ?? require
    return req('@parcel/watcher') as ParcelModule
  } catch {
    warn('graph_view: corpus watcher unavailable', { reason: 'module-not-found' })
    return null
  }
}

function isMissingError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}

function walkMdFiles(dir: string, out: Set<string>): void {
  let dirents
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    // The whole subtree under `dir` is absent from this flush. That is a
    // partially-live graph, so it must be visible in the log.
    warn('graph_view: corpus watch directory unreadable', { dir, error: String(err) })
    return
  }
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue
    const full = join(dir, d.name)
    if (d.isDirectory()) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue
      walkMdFiles(full, out)
      continue
    }
    if (/\.md$/i.test(d.name)) out.add(full)
  }
}

function isDirectorySafe(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch (err) {
    if (isMissingError(err)) {
      debug('graph_view: corpus watch path missing', { path, reason: 'missing' })
    } else {
      warn('graph_view: corpus watch stat failed', { path, error: String(err) })
    }
    return false
  }
}

interface ProjectWatch {
  subscriptions: Map<string, ParcelSubscription> // keyed by root path
  pending: Set<string>
  debounceTimer: ReturnType<typeof setTimeout> | null
  callbacks: CorpusWatcherCallbacks
}

/**
 * Create a corpus watcher. Falls back to a no-op when the native module is
 * unavailable. `requireFn` is a test-only seam for exercising the
 * module-unavailable branch without mocking Node's `require` machinery.
 */
export function createCorpusWatcher(parcel?: ParcelModule | null, requireFn?: (id: string) => unknown): CorpusWatcher {
  const mod = resolveParcelModule(parcel, requireFn)
  const projects = new Map<string, ProjectWatch>()

  if (!mod) {
    return {
      start: () => {},
      reconfigure: () => {},
      stop: () => {},
      available: false,
    }
  }

  function scheduleFlush(projectPath: string): void {
    const pw = projects.get(projectPath)
    if (!pw) return
    if (pw.debounceTimer) clearTimeout(pw.debounceTimer)
    pw.debounceTimer = setTimeout(() => flush(projectPath), DEBOUNCE_MS)
  }

  function flush(projectPath: string): void {
    const pw = projects.get(projectPath)
    if (!pw) return
    pw.debounceTimer = null
    const expanded = new Set<string>()
    for (const p of pw.pending) {
      if (/\.md$/i.test(p)) {
        expanded.add(p)
        continue
      }
      // A directory event: a create expands to its .md files on disk; a
      // delete expands to every cached document under that prefix, which
      // the caller resolves (this module owns no cache).
      if (isDirectorySafe(p)) {
        walkMdFiles(p, expanded)
      } else {
        for (const known of pw.callbacks.getKnownPathsUnderPrefix(p)) expanded.add(known)
      }
    }
    pw.pending.clear()
    pw.callbacks.onFlush(expanded)
  }

  function subscribeRoot(projectPath: string, root: CorpusRootConfig): void {
    const pw = projects.get(projectPath)
    if (!pw || pw.subscriptions.has(root.path)) return
    if (!isDirectorySafe(root.path)) return

    mod!
      .subscribe(
        root.path,
        (err, events) => {
          const current = projects.get(projectPath)
          if (!current) return
          if (err) {
            warn('graph_view: corpus watch error', { rootPath: root.path, error: err.message })
            current.callbacks.onRootWatchState(root.path, 'failed', err.message)
            return
          }
          for (const e of events) current.pending.add(e.path)
          if (events.length > 0) scheduleFlush(projectPath)
        },
        { ignore: IGNORE },
      )
      .then((sub) => {
        const current = projects.get(projectPath)
        if (!current) {
          void sub.unsubscribe()
          return
        }
        current.subscriptions.set(root.path, sub)
        debug('graph_view: corpus watch root subscribed', { rootPath: root.path })
        current.callbacks.onRootWatchState(root.path, 'watching', 'subscribed')
      })
      .catch((err: Error) => {
        warn('graph_view: corpus watch subscribe failed', { rootPath: root.path, error: err.message })
        const current = projects.get(projectPath)
        current?.callbacks.onRootWatchState(root.path, 'failed', err.message)
      })
  }

  function unsubscribeRoot(pw: ProjectWatch, rootPath: string): void {
    const sub = pw.subscriptions.get(rootPath)
    if (!sub) return
    pw.subscriptions.delete(rootPath)
    void sub.unsubscribe().catch((err: Error) => {
      debug('graph_view: corpus watch unsubscribe failed', { rootPath, error: err.message })
    })
  }

  return {
    available: true,

    start(projectPath, roots, callbacks) {
      if (projects.has(projectPath)) return
      const pw: ProjectWatch = {
        subscriptions: new Map(),
        pending: new Set(),
        debounceTimer: null,
        callbacks,
      }
      projects.set(projectPath, pw)
      for (const root of roots) subscribeRoot(projectPath, root)
      log('graph_view: corpus watch started', { projectPath, rootCount: roots.length, watchState: 'watching' })
    },

    reconfigure(projectPath, roots) {
      const pw = projects.get(projectPath)
      if (!pw) return
      const nextPaths = new Set(roots.map((r) => r.path))
      const currentPaths = new Set(pw.subscriptions.keys())

      const added = roots.filter((r) => !currentPaths.has(r.path))
      const removed = [...currentPaths].filter((p) => !nextPaths.has(p))

      for (const rootPath of removed) unsubscribeRoot(pw, rootPath)
      for (const root of added) subscribeRoot(projectPath, root)

      log('graph_view: corpus watch reconfigured', {
        addedRoots: added.map((r) => r.path).join(','),
        removedRoots: removed.join(','),
      })
    },

    stop(projectPath) {
      const pw = projects.get(projectPath)
      if (!pw) return
      if (pw.debounceTimer) clearTimeout(pw.debounceTimer)
      for (const rootPath of [...pw.subscriptions.keys()]) unsubscribeRoot(pw, rootPath)
      projects.delete(projectPath)
    },
  }
}
