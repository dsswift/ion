/**
 * Corpus scanner: a stack-based recursive walk over the configured roots
 * that collects every `.md` file and parses it. Stack-based rather than
 * recursive so a deep tree at 10,000-document scale doesn't grow a call
 * stack for no benefit.
 *
 * Async and yields to the event loop periodically so a large cold scan
 * never blocks an IPC reply or a window paint.
 */

import { existsSync, readdirSync, statSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { log as _log, debug as _debug, warn as _warn } from '../logger'
import { parseMarkdownDocument } from './markdown-parse'
import type { CorpusDocument, CorpusRootStatus, CorpusSnapshot } from '../../shared/graph-corpus-types'
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

const SKIP_DIRS = new Set(['.git', 'node_modules'])
export const MAX_FILE_BYTES = 2 * 1024 * 1024
const YIELD_EVERY = 200

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface WalkCounters {
  seen: number
  skippedTooLarge: number
  parseErrorCount: number
}

async function walkRoot(rootPath: string, out: CorpusDocument[], counters: WalkCounters): Promise<void> {
  const stack: string[] = [rootPath]
  const visitedRealDirs = new Set<string>()

  while (stack.length > 0) {
    const dir = stack.pop()!
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      warn('graph_view: failed to read directory during scan', { dir, error: String(err) })
      continue
    }

    for (const d of dirents) {
      if (d.isSymbolicLink()) continue
      const full = join(dir, d.name)

      if (d.isDirectory()) {
        if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue
        // Cycle guard: resolve a real path once per directory to defend
        // against a symlink loop that readdirSync's isSymbolicLink() check
        // on the immediate entry doesn't catch (a symlinked ancestor two
        // levels up pointing back into the tree). Cheap relative to a scan.
        try {
          const real = realpathSync(full)
          if (visitedRealDirs.has(real)) continue
          visitedRealDirs.add(real)
        } catch {
          // silent-ok: a realpath failure here means the directory vanished
          // mid-walk; the subsequent readdirSync on it will fail and warn.
        }
        stack.push(full)
        continue
      }

      if (!/\.md$/i.test(d.name)) continue

      let st
      try {
        st = statSync(full)
      } catch (err) {
        warn('graph_view: failed to stat file during scan', { path: full, error: String(err) })
        continue
      }

      if (st.size > MAX_FILE_BYTES) {
        counters.skippedTooLarge++
        warn('graph_view: file skipped, over size cap', { path: full, sizeBytes: st.size })
        continue
      }

      let text: string
      try {
        text = readFileSync(full, 'utf-8')
      } catch (err) {
        warn('graph_view: failed to read file during scan', { path: full, error: String(err) })
        continue
      }

      const doc = parseMarkdownDocument(text, full, rootPath, st)
      if (doc.parseError) counters.parseErrorCount++
      out.push(doc)

      counters.seen++
      if (counters.seen % YIELD_EVERY === 0) await yieldToEventLoop()
    }
  }
}

/**
 * Scan every configured corpus root. A root that does not exist, is not a
 * directory, or contains no `.md` files contributes nothing and is never an
 * error. `scanCorpus` itself logs only its completion; the caller
 * (`corpus-store.ts`) logs the start with the `projectPath` this pure
 * function does not receive.
 */
export async function scanCorpus(config: GraphViewConfig): Promise<CorpusSnapshot> {
  const started = Date.now()
  const documents: CorpusDocument[] = []
  const roots: CorpusRootStatus[] = []
  const counters: WalkCounters = { seen: 0, skippedTooLarge: 0, parseErrorCount: 0 }

  for (const root of config.corpusRoots) {
    let exists = false
    try {
      exists = existsSync(root.path) && statSync(root.path).isDirectory()
    } catch (err) {
      // A root that is not there contributes nothing and is not an error;
      // a root that cannot be stat'ed for any other reason is.
      if ((err as { code?: string }).code === 'ENOENT') {
        debug('graph_view: corpus root missing', { rootPath: root.path, reason: 'missing' })
      } else {
        warn('graph_view: corpus root stat failed', { rootPath: root.path, error: String(err) })
      }
      exists = false
    }

    const before = documents.length
    if (exists) await walkRoot(root.path, documents, counters)
    const documentCount = documents.length - before
    roots.push({ path: root.path, ...(root.label ? { label: root.label } : {}), exists, documentCount })
    debug('graph_view: corpus scan per-root result', { rootPath: root.path, exists, documentCount })
  }

  const durationMs = Date.now() - started
  log('graph_view: corpus scan complete', {
    documentCount: documents.length,
    rootCount: config.corpusRoots.length,
    durationMs,
    parseErrorCount: counters.parseErrorCount,
    skippedTooLarge: counters.skippedTooLarge,
  })

  return { revision: 0, roots, documents }
}
