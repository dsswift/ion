/**
 * Pure incremental re-index: compute a `CorpusDelta` from a set of pending
 * paths against a cached snapshot, and apply that delta back onto a
 * snapshot. No disk watching lives here — `corpus-watch.ts` owns that.
 *
 * Existence is decided by `existsSync` AT FLUSH TIME, never by the watcher
 * event's own type. A create followed by a delete inside one debounce
 * window therefore nets out correctly with no event-type bookkeeping, and a
 * rename (delete + create in the same window) needs no special case.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { warn as _warn } from '../logger'
import { parseMarkdownDocument } from './markdown-parse'
import { MAX_FILE_BYTES } from './corpus-scan'
import type { CorpusDocument, CorpusRootStatus, CorpusSnapshot } from '../../shared/graph-corpus-types'
import type { GraphViewConfig } from '../../shared/graph-view-types'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

export interface ComputedDelta {
  upserted: CorpusDocument[]
  removedPaths: string[]
}

/** The longest configured root path that is a prefix of `path`, or `null`. */
function longestMatchingRoot(path: string, roots: GraphViewConfig['corpusRoots']): string | null {
  let best: string | null = null
  for (const root of roots) {
    if (path === root.path || path.startsWith(root.path.endsWith('/') ? root.path : root.path + '/')) {
      if (best === null || root.path.length > best.length) best = root.path
    }
  }
  return best
}

/** Compute an incremental delta for a set of pending absolute paths. */
export function computeDelta(
  snapshot: CorpusSnapshot,
  pendingPaths: Iterable<string>,
  config: GraphViewConfig,
): ComputedDelta {
  const known = new Map(snapshot.documents.map((d) => [d.path, d]))
  const upserted: CorpusDocument[] = []
  const removedPaths: string[] = []

  for (const path of pendingPaths) {
    const rootPath = longestMatchingRoot(path, config.corpusRoots)
    if (rootPath === null) continue // a root was removed mid-flight

    let exists = false
    try {
      exists = existsSync(path)
    } catch {
      exists = false
    }
    if (!exists) {
      if (known.has(path)) removedPaths.push(path)
      continue
    }

    let st
    try {
      st = statSync(path)
    } catch (err) {
      warn('graph_view: corpus reindex stat failed', { path, error: String(err) })
      continue
    }

    if (st.size > MAX_FILE_BYTES) {
      if (known.has(path)) removedPaths.push(path)
      continue
    }

    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch (err) {
      warn('graph_view: corpus reindex read failed', { path, error: String(err) })
      continue
    }

    upserted.push(parseMarkdownDocument(text, path, rootPath, st))
  }

  return { upserted, removedPaths }
}

/**
 * Recount each root's documents. The per-root `watch` state is carried over
 * from the previous status by path — a recount knows nothing about the
 * watcher, and dropping the field would silently reset a failed root to
 * "unknown" on every delta.
 */
function recountRoots(documents: CorpusDocument[], config: GraphViewConfig, previous: CorpusRootStatus[]): CorpusRootStatus[] {
  const previousWatch = new Map(previous.map((r) => [r.path, r.watch]))
  const roots: CorpusRootStatus[] = []
  for (const root of config.corpusRoots) {
    let exists = false
    try {
      exists = existsSync(root.path) && statSync(root.path).isDirectory()
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        warn('graph_view: corpus reindex root stat failed', { rootPath: root.path, error: String(err) })
      }
      exists = false
    }
    const documentCount = documents.filter((d) => d.rootPath === root.path).length
    const watch = previousWatch.get(root.path)
    roots.push({ path: root.path, ...(root.label ? { label: root.label } : {}), exists, documentCount, ...(watch ? { watch } : {}) })
  }
  return roots
}

/** Apply a computed delta onto a cached snapshot, producing a new snapshot. */
export function applyDelta(
  snapshot: CorpusSnapshot,
  delta: ComputedDelta & { revision: number },
  config: GraphViewConfig,
): CorpusSnapshot {
  const byPath = new Map(snapshot.documents.map((d) => [d.path, d]))
  for (const d of delta.upserted) byPath.set(d.path, d)
  for (const p of delta.removedPaths) byPath.delete(p)
  const documents = [...byPath.values()]
  const roots = recountRoots(documents, config, snapshot.roots)
  return {
    revision: delta.revision,
    roots,
    documents,
    ...(snapshot.watchState ? { watchState: snapshot.watchState } : {}),
  }
}
