/**
 * Virtual anchor nodes: a promoted note-descriptive property drawn as one
 * node per distinct value, gathering the documents that carry it.
 *
 * An anchor is a cluster centre, not a connector. A content-descriptive
 * value (a topic) weaves documents together across the corpus; a promoted
 * value (an ownership scope, a directory) is usually single-valued per
 * document and only says where the document sits. So an anchor gathers and
 * nothing more: it never produces a cross-cutting edge, and it is a third
 * visual class distinct from documents and topics (`kind: 'anchor'`).
 *
 * Two guards keep promotion from re-creating the hub it exists to avoid:
 *
 * - **Hierarchy depth.** A path or a scope promoted at its top level draws
 *   one node touching most of the corpus. `depth` on the promoted field
 *   keeps that many leading `/` segments, so `sections/staff/journal` can be
 *   the anchor rather than `sections`.
 * - **Cardinality suppression.** A value on nearly every document carries
 *   no information as a node, and a value on a single document gathers
 *   nothing. Both are withheld and reported (`AnchorSuppression`), and a
 *   property whose every value is withheld is suppressed whole.
 *
 * The guard applies to promoted-property values only. A document node with
 * many genuine edges is never thinned by anything here.
 */

import type { CorpusDocument } from './graph-corpus-types'
import type { GraphPromotedField, GraphViewConfig } from './graph-view-types'
import type { AnchorSuppression, GraphNode } from './graph-model-types'
import { toValueList } from './graph-model-resolve'

/** A value carried by at least this share of the documents that carry the property is a hub, and is suppressed. */
export const ANCHOR_HUB_SHARE = 0.9
/** A value must gather at least this many documents to be an anchor. */
export const ANCHOR_MIN_DOCUMENTS = 2
/** The field name that promotes a document's location rather than a front-matter property. */
export const ANCHOR_PATH_FIELD = 'path'

export interface AnchorMembership {
  docId: string
  anchorId: string
  field: string
}

export interface AnchorResult {
  nodes: GraphNode[]
  memberships: AnchorMembership[]
  suppressions: AnchorSuppression[]
}

/** The raw values a document carries for a promoted field: front matter, or the root-relative path for `path`. */
function rawValues(doc: CorpusDocument, promoted: GraphPromotedField): string[] {
  if (promoted.field === ANCHOR_PATH_FIELD) {
    const relative = doc.path.startsWith(doc.rootPath) ? doc.path.slice(doc.rootPath.length).replace(/^\/+/, '') : doc.path
    // The anchor is the directory the document sits in, never the file.
    const dir = relative.split('/').slice(0, -1).join('/')
    return dir ? [dir] : []
  }
  return toValueList(doc.frontMatter[promoted.field])
}

/** Apply the promoted field's segment split and depth cut to one raw value. Null when the value has no such segment. */
export function anchorValue(raw: string, promoted: GraphPromotedField): string | null {
  let value = raw
  if (promoted.split) {
    const parts = raw.split(promoted.split.separator)
    const segment = parts[promoted.split.index]
    if (segment === undefined || segment === '') return null
    value = segment
  }
  const depth = promoted.depth ?? 0
  if (depth > 0) {
    const segments = value.split('/').filter((s) => s.length > 0)
    if (segments.length === 0) return null
    value = segments.slice(0, depth).join('/')
  }
  return value.length > 0 ? value : null
}

export function anchorNodeId(field: string, value: string): string {
  return `anchor:${field}:${value}`
}

/**
 * Build anchor nodes and memberships for every promoted field in
 * `active`. Fields not in `active` are not drawn (promotion is a view-time
 * toggle); fields in `active` but not configured are ignored.
 */
export function buildAnchorNodes(
  documents: CorpusDocument[],
  config: GraphViewConfig,
  idByPath: Map<string, string>,
  active: ReadonlySet<string>,
): AnchorResult {
  const nodes: GraphNode[] = []
  const memberships: AnchorMembership[] = []
  const suppressions: AnchorSuppression[] = []

  for (const promoted of config.promotedFields) {
    if (!active.has(promoted.field)) continue

    // One pass to count: which documents carry each value at the chosen depth.
    const docsByValue = new Map<string, Set<string>>()
    let carrying = 0
    for (const doc of documents) {
      const docId = idByPath.get(doc.path)!
      const values = new Set<string>()
      for (const raw of rawValues(doc, promoted)) {
        const v = anchorValue(raw, promoted)
        if (v !== null) values.add(v)
      }
      if (values.size === 0) continue
      carrying++
      for (const v of values) {
        let set = docsByValue.get(v)
        if (!set) {
          set = new Set()
          docsByValue.set(v, set)
        }
        set.add(docId)
      }
    }

    const kept = new Map<string, Set<string>>()
    for (const [value, docs] of docsByValue) {
      if (docs.size >= Math.max(ANCHOR_MIN_DOCUMENTS, Math.ceil(carrying * ANCHOR_HUB_SHARE)) && docsByValue.size > 1) {
        suppressions.push({ field: promoted.field, value, documentCount: docs.size, reason: 'hub' })
        continue
      }
      if (docs.size < ANCHOR_MIN_DOCUMENTS) {
        suppressions.push({ field: promoted.field, value, documentCount: docs.size, reason: 'singleton' })
        continue
      }
      kept.set(value, docs)
    }

    // A property with one value on everything, or whose every value was
    // withheld, discriminates nothing at this depth: suppress it whole
    // rather than drawing one hub or nothing at all under its name.
    if (docsByValue.size > 0 && (kept.size === 0 || (docsByValue.size === 1 && carrying > ANCHOR_MIN_DOCUMENTS))) {
      suppressions.push({ field: promoted.field, value: null, documentCount: carrying, reason: 'degenerate-property' })
      continue
    }

    for (const [value, docs] of kept) {
      const anchorId = anchorNodeId(promoted.field, value)
      nodes.push({
        id: anchorId,
        kind: 'anchor',
        label: value,
        frontMatter: {},
        sizeBytes: 0,
        modifiedMs: 0,
        degree: 0,
        community: -1,
        centrality: 0,
        orphan: false,
      })
      for (const docId of docs) memberships.push({ docId, anchorId, field: promoted.field })
    }
  }

  return { nodes, memberships, suppressions }
}
