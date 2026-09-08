/**
 * Graph model shared contract (C3).
 *
 * A pure, synchronous transform from a `CorpusSnapshot` (child 02) into a
 * `GraphModel`: identity, labels, groups, edges, dangling references, and
 * structural metrics. No metadata vocabulary is hardcoded — every field name
 * this layer reads comes from `GraphViewConfig`.
 *
 * Frozen by the program manifest as C3; created here by child 04.
 */

/**
 * The structural classes a node can belong to. Four of them are visually
 * distinct by contract: a `document` is a file, a `group` is a shared
 * content value (a topic), an `anchor` is a promoted note-descriptive value
 * (an ownership scope, a directory) that gathers the documents carrying it,
 * and a `section` is one heading's worth of a document. A `dangling` node
 * stands in for a reference nothing resolves.
 */
export type GraphNodeKind = 'document' | 'group' | 'anchor' | 'section' | 'dangling'

export interface GraphNode {
  /** Resolved identity. Unique across the whole corpus. */
  id: string
  kind: GraphNodeKind
  label: string
  /** Absent on group and dangling nodes. */
  path?: string
  rootPath?: string
  /** Raw front matter for document nodes; `{}` otherwise. Read by hover + encoding. */
  frontMatter: Record<string, unknown>
  sizeBytes: number
  modifiedMs: number
  degree: number
  /** Louvain community index. -1 until computed. */
  community: number
  /** Centrality in [0,1]. Which algorithm produced it is recorded in `GraphModel.centralityMethod`, not fixed here. */
  centrality: number
  orphan: boolean
}

/**
 * What produced an edge. The first three are curated document-to-document
 * claims an author made by hand; `group` and `anchor` are mediated by a
 * shared node and are weaker, incidental claims; `section` is the
 * structural tie between a document and one of its own parts. A consumer
 * that styles or weights edges tells these apart by this field (see
 * `curatedOrigin`).
 */
export type GraphEdgeOrigin = 'wikilink' | 'markdown-link' | 'front-matter' | 'group' | 'anchor' | 'section'

/** Whether an origin is a hand-curated document link rather than a node-mediated or structural tie. */
export function curatedOrigin(origin: GraphEdgeOrigin): boolean {
  return origin === 'wikilink' || origin === 'markdown-link' || origin === 'front-matter'
}

export interface GraphEdge {
  /** `${source}|${target}|${origin}|${field ?? ''}` — stable and collision-free. */
  id: string
  source: string
  target: string
  directed: boolean
  origin: GraphEdgeOrigin
  /** Front-matter field name that produced it. Absent for body links. */
  field?: string
  /** Distinct link instances collapsed into this edge. Always at least 1. */
  multiplicity: number
  crossRoot: boolean
  /** True when `target` resolves to a `kind: 'dangling'` node. */
  dangling: boolean
  /** Newest `modifiedMs` of the two endpoints. Drives the edge-recency channel. */
  recencyMs: number
}

export interface DanglingReference {
  /** Node id of the document holding the bad reference. */
  sourceId: string
  sourcePath: string
  /** The unresolved target text, verbatim from the document. */
  rawTarget: string
  origin: GraphEdgeOrigin
  field?: string
}

export interface IdentityCollision {
  identity: string
  /** Absolute path of the document that kept the identity. */
  winnerPath: string
  /** Absolute paths that fell back to their own path. */
  loserPaths: string[]
}

/**
 * A promoted value, or a whole promoted property, that the cardinality
 * guard declined to draw. A value on nearly every document is a hub that
 * says nothing, and a value on a single document gathers nothing; both are
 * reported rather than drawn so the operator can see what the guard did.
 */
export interface AnchorSuppression {
  field: string
  /** The suppressed value at the configured depth, or null when the whole property was suppressed. */
  value: string | null
  /** Documents carrying the value (or, for a whole property, the documents carrying the property). */
  documentCount: number
  reason: 'hub' | 'singleton' | 'degenerate-property'
}

export interface GraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
  dangling: DanglingReference[]
  /** What the anchor cardinality guard withheld on this build. Empty when nothing is promoted. */
  anchorSuppressions: AnchorSuppression[]
  /** Distinct front-matter field names seen anywhere in the corpus, sorted. */
  discoveredFields: string[]
  identityCollisions: IdentityCollision[]
  /** Which centrality algorithm was used: exact under 2000 nodes, approximated above. */
  centralityMethod: 'betweenness' | 'degree'
}
