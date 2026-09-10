/**
 * Per-project corpus snapshot cache: subscribe/unsubscribe refcounting, a
 * monotonic revision counter shared across every project, and (child 03)
 * live-watch wiring that turns a disk change into an incremental
 * `CorpusDelta` broadcast.
 */

import { sep } from 'path'
import { log as _log, debug as _debug } from '../logger'
import { broadcast } from '../broadcast'
import { IPC } from '../../shared/types-ipc'
import { getGraphViewConfig, onGraphViewConfigChanged, watchProject, unwatchProject } from './config-store'
import { scanCorpus } from './corpus-scan'
import { computeDelta, applyDelta } from './corpus-reindex'
import { createCorpusWatcher, type CorpusWatcher, type ParcelModule } from './corpus-watch'
import type { CorpusSnapshot, CorpusDelta, CorpusRootStatus, CorpusRootWatchState, CorpusWatchState } from '../../shared/graph-corpus-types'
import type { GraphViewConfig } from '../../shared/graph-view-types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

interface CorpusEntry {
  snapshot: CorpusSnapshot
  refCount: number
  config: GraphViewConfig
}

const corpusCache = new Map<string, CorpusEntry>()
let revisionCounter = 0
let watcher: CorpusWatcher | null = null

/** Test/injection seam: install a specific watcher (e.g. with a fake ParcelModule). */
export function _setCorpusWatcherForTest(parcel?: ParcelModule): void {
  watcher = createCorpusWatcher(parcel)
}

function getWatcher(): CorpusWatcher {
  if (!watcher) watcher = createCorpusWatcher()
  return watcher
}

/** Monotonic revision counter shared across every project's corpus. */
export function nextRevision(): number {
  return ++revisionCounter
}

/** The cached snapshot for a project, or `undefined` when not subscribed. */
export function getCachedSnapshot(projectPath: string): CorpusSnapshot | undefined {
  return corpusCache.get(projectPath)?.snapshot
}

/** Replace the cached snapshot for a project without touching refcount. */
export function replaceSnapshot(projectPath: string, snapshot: CorpusSnapshot): void {
  const entry = corpusCache.get(projectPath)
  if (entry) {
    entry.snapshot = snapshot
  } else {
    corpusCache.set(projectPath, { snapshot, refCount: 0, config: getGraphViewConfig(projectPath) })
  }
}

const EMPTY_SNAPSHOT: CorpusSnapshot = { revision: 0, roots: [], documents: [] }

function onFlush(projectPath: string, mdPaths: Set<string>): void {
  if (mdPaths.size === 0) {
    debug('graph_view: corpus delta dropped', { projectPath, reason: 'empty-delta' })
    return
  }
  const entry = corpusCache.get(projectPath)
  if (!entry) return

  const started = Date.now()
  const computed = computeDelta(entry.snapshot, mdPaths, entry.config)
  if (computed.upserted.length === 0 && computed.removedPaths.length === 0) {
    debug('graph_view: corpus delta dropped', { projectPath, reason: 'empty-delta' })
    return
  }

  const revision = nextRevision()
  const delta: CorpusDelta & { revision: number } = { revision, upserted: computed.upserted, removedPaths: computed.removedPaths, roots: [] }
  const nextSnapshot = applyDelta(entry.snapshot, delta, entry.config)
  delta.roots = nextSnapshot.roots

  // Snapshot replaced BEFORE broadcast: a subscriber arriving between two
  // deltas must never read a snapshot older than the delta it just received.
  entry.snapshot = nextSnapshot
  broadcast(IPC.GRAPH_CORPUS_DELTA, projectPath, delta)

  debug('graph_view: corpus delta', {
    projectPath,
    revision,
    upsertedCount: computed.upserted.length,
    removedCount: computed.removedPaths.length,
    durationMs: Date.now() - started,
  })
}

/**
 * The corpus-wide watch state is derived from the per-root outcomes: every
 * reported root watching → `watching`; any root failed → `partial`. A root
 * that has not reported yet does not count against liveness — the initial
 * snapshot says `watching` and a failure downgrades it when it arrives.
 */
export function deriveWatchState(roots: CorpusRootStatus[], watcherAvailable: boolean): CorpusWatchState {
  if (!watcherAvailable) return 'unavailable'
  return roots.some((r) => r.watch === 'failed') ? 'partial' : 'watching'
}

/**
 * Record one root's watch outcome and, when the corpus-wide state changes,
 * broadcast a roots-only delta so every subscriber's chrome tells the truth
 * about which roots are live. Subscriptions resolve after the initial
 * snapshot has already been returned, so this is the only path by which a
 * failed root ever reaches the renderer.
 */
function onRootWatchState(projectPath: string, rootPath: string, state: CorpusRootWatchState, reason: string): void {
  const entry = corpusCache.get(projectPath)
  if (!entry) return
  const previousState = entry.snapshot.watchState
  const roots = entry.snapshot.roots.map((r) => (r.path === rootPath ? { ...r, watch: state } : r))
  const watchState = deriveWatchState(roots, getWatcher().available)
  const changedRoot = entry.snapshot.roots.find((r) => r.path === rootPath)?.watch !== state

  log('graph_view: corpus watch state changed', { projectPath, rootPath, state, reason, watchState, previousWatchState: previousState ?? 'unknown' })

  if (!changedRoot) return
  entry.snapshot = { ...entry.snapshot, roots, watchState }

  // A root resolving to `watching` confirms what the initial snapshot already
  // claimed, so it is recorded but not broadcast. A failure — or a recovery
  // that changes the corpus-wide state — is what subscribers must hear about,
  // because the chip reads both the state and the failed-root count.
  if (state !== 'failed' && watchState === previousState) return
  const revision = nextRevision()
  entry.snapshot = { ...entry.snapshot, revision }
  const delta: CorpusDelta = { revision, upserted: [], removedPaths: [], roots, watchState }
  broadcast(IPC.GRAPH_CORPUS_DELTA, projectPath, delta)
}

function getKnownPathsUnderPrefix(projectPath: string, directoryPath: string): string[] {
  const entry = corpusCache.get(projectPath)
  if (!entry) return []
  // Real filesystem paths: judge containment with the platform separator, not
  // a hardcoded '/' that never matches a Windows path joined with '\'.
  const prefix = directoryPath.endsWith(sep) ? directoryPath : `${directoryPath}${sep}`
  return entry.snapshot.documents.filter((d) => d.path.startsWith(prefix)).map((d) => d.path)
}

/**
 * Subscribe to a project's corpus. Returns the cached snapshot if present;
 * otherwise scans and caches. With an empty `corpusRoots`, returns the empty
 * snapshot and performs zero disk work.
 */
export async function subscribeCorpus(projectPath: string): Promise<CorpusSnapshot> {
  const existing = corpusCache.get(projectPath)
  if (existing) {
    existing.refCount++
    return existing.snapshot
  }

  const config = getGraphViewConfig(projectPath)
  if (config.corpusRoots.length === 0) {
    debug('graph_view: corpus subscribe skipped', { projectPath, reason: 'no-corpus-roots' })
    corpusCache.set(projectPath, { snapshot: EMPTY_SNAPSHOT, refCount: 1, config })
    return EMPTY_SNAPSHOT
  }

  watchProject(projectPath)
  log('graph_view: corpus scan started', { projectPath, rootCount: config.corpusRoots.length })
  const scanned = await scanCorpus(config)
  const w = getWatcher()
  const snapshot: CorpusSnapshot = { ...scanned, revision: nextRevision(), watchState: w.available ? 'watching' : 'unavailable' }
  corpusCache.set(projectPath, { snapshot, refCount: 1, config })

  w.start(projectPath, config.corpusRoots, {
    onFlush: (mdPaths) => onFlush(projectPath, mdPaths),
    getKnownPathsUnderPrefix: (dir) => getKnownPathsUnderPrefix(projectPath, dir),
    onRootWatchState: (rootPath, state, reason) => onRootWatchState(projectPath, rootPath, state, reason),
  })

  return snapshot
}

/** Release one reference on a project's corpus subscription. */
export function unsubscribeCorpus(projectPath: string): void {
  const entry = corpusCache.get(projectPath)
  if (!entry) return
  entry.refCount--
  if (entry.refCount <= 0) {
    getWatcher().stop(projectPath)
    if (entry.config.corpusRoots.length > 0) unwatchProject(projectPath)
    corpusCache.delete(projectPath)
  }
}

/**
 * Reconfigure a subscribed project's watch set after a
 * `GRAPH_VIEW_CONFIG_CHANGED` broadcast: removed roots drop their documents
 * in one delta, added roots are cold-scanned into one delta.
 */
export async function reconfigureCorpusWatch(projectPath: string, nextConfig: GraphViewConfig): Promise<void> {
  const entry = corpusCache.get(projectPath)
  if (!entry) return

  const prevRoots = new Set(entry.config.corpusRoots.map((r) => r.path))
  const nextRoots = new Set(nextConfig.corpusRoots.map((r) => r.path))
  const removedRoots = [...prevRoots].filter((p) => !nextRoots.has(p))
  const addedRoots = nextConfig.corpusRoots.filter((r) => !prevRoots.has(r.path))

  entry.config = nextConfig
  getWatcher().reconfigure(projectPath, nextConfig.corpusRoots)

  if (removedRoots.length === 0 && addedRoots.length === 0) return

  const removedPaths = entry.snapshot.documents.filter((d) => removedRoots.includes(d.rootPath)).map((d) => d.path)

  let upserted: CorpusSnapshot['documents'] = []
  if (addedRoots.length > 0) {
    const scanned = await scanCorpus({ ...nextConfig, corpusRoots: addedRoots })
    upserted = scanned.documents
  }

  if (removedPaths.length === 0 && upserted.length === 0) return

  const revision = nextRevision()
  const delta: CorpusDelta = { revision, upserted, removedPaths, roots: [] }
  const nextSnapshot = applyDelta(entry.snapshot, { ...delta }, nextConfig)
  delta.roots = nextSnapshot.roots
  entry.snapshot = nextSnapshot
  broadcast(IPC.GRAPH_CORPUS_DELTA, projectPath, delta)
}

/** Test-only: reset all module state between test cases. */
export function _resetCorpusStoreForTest(): void {
  corpusCache.clear()
  revisionCounter = 0
  watcher = null
}

// Reconfigure a subscribed project's watch set whenever its resolved config
// changes — one listener for the whole module's lifetime, registered once.
onGraphViewConfigChanged((projectPath, nextConfig) => {
  void reconfigureCorpusWatch(projectPath, nextConfig)
})
