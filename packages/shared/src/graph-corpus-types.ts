/**
 * Corpus Index shared contract (C2).
 *
 * The corpus index is vocabulary-free: it emits a raw front-matter bag plus
 * resolved link lists. Identity, labels, grouping, and edges are resolved a
 * layer up (child 04's graph model). Frozen by the program manifest;
 * created here by child 02.
 */

export interface CorpusDocument {
  /** Absolute path. Doubles as the identity fallback and the delta key. */
  path: string
  /** Absolute path of the configured root this file was found under. */
  rootPath: string
  /** Basename without the `.md` extension. Label fallback. */
  fileName: string
  /** Raw YAML front matter. `{}` when absent, malformed, or not a mapping. */
  frontMatter: Record<string, unknown>
  /** Raw `[[target]]` targets, pipe-alias stripped, in document order. */
  wikiLinks: string[]
  /** Raw `[label](target)` targets whose target ends in `.md`, in document order. */
  markdownLinks: string[]
  /** `## Heading` texts, in document order. Empty when section nodes are off. */
  sections: string[]
  sizeBytes: number
  modifiedMs: number
  /** Present when front matter was found but did not parse. Document still emitted. */
  parseError?: string
}

/** Whether one root's live watch is running. Absent until the watcher reports for that root. */
export type CorpusRootWatchState = 'watching' | 'failed'

export interface CorpusRootStatus {
  path: string
  label?: string
  exists: boolean
  documentCount: number
  /** Per-root live-watch outcome. A `failed` root is a point-in-time read while the others stay live. */
  watch?: CorpusRootWatchState
}

/**
 * Whether the corpus is live-watched. `partial` means the watcher module is
 * present but at least one root's subscription failed — the graph is live
 * for the other roots only. Derived from the per-root `watch` fields.
 */
export type CorpusWatchState = 'watching' | 'partial' | 'unavailable'

export interface CorpusSnapshot {
  /** Monotonic. Increments on every snapshot and every delta. */
  revision: number
  roots: CorpusRootStatus[]
  documents: CorpusDocument[]
  /** Present once child 03 ships live watching. */
  watchState?: CorpusWatchState
}

export interface CorpusDelta {
  revision: number
  /** Full replacement documents, keyed by `path`. */
  upserted: CorpusDocument[]
  removedPaths: string[]
  roots: CorpusRootStatus[]
  /** Present when a root's watch state changed; a roots-only delta carries it with no documents. */
  watchState?: CorpusWatchState
}
