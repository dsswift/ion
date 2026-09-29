/**
 * Edge resolution: the four edge sources (body wikilinks, body Markdown
 * links, front-matter reference fields, and front-matter supersession
 * fields), reference resolution against the identity/path/filename indexes,
 * collapse of repeated identical references into one edge with a
 * multiplicity count, and dangling-reference records for anything that
 * doesn't resolve.
 *
 * Supersession direction is structural, never configurable: only
 * `supersedes` and `superseded-by` carry `directed: true`. Every other
 * origin — including a corpus-chosen custom field in `edgeFields` — is
 * undirected. This is a deliberate design decision (see the program
 * manifest's edge cases), not an oversight.
 */

import { dirnamePath, isAbsolutePath, joinPaths, normalizePath } from './graph-model-path'
import type { CorpusDocument } from './graph-corpus-types'
import type { GraphViewConfig } from './graph-view-types'
import type { DanglingReference, GraphEdge, GraphEdgeOrigin, GraphNode } from './graph-model-types'
import { AMBIGUOUS, toValueList, type GroupMembership, type ReferenceIndexes } from './graph-model-resolve'
import type { AnchorMembership } from './graph-model-anchors'

const DIRECTED_FIELDS = new Set(['supersedes', 'superseded-by'])

/** Strip a quoted-wikilink form (`"[[alpha]]"`) down to its bare target. */
function stripWikiBrackets(value: string): string {
  const m = /^\[\[([^\]]+)\]\]$/.exec(value.trim())
  return m ? m[1] : value
}

/**
 * Resolve a raw reference target against, in order: the identity index
 * (full target, then base before any `#section`); the path index, resolved
 * relative to the linking document's directory; then the filename index
 * (case-insensitive, only when unambiguous). A hit with a `#section` suffix
 * resolves to the section node when section nodes are on and the heading
 * exists — the first section with that heading text, since a link names a
 * heading and never an ordinal; otherwise it resolves to the document,
 * discarding the suffix.
 */
export function resolveReference(
  rawTarget: string,
  fromDoc: CorpusDocument,
  indexes: ReferenceIndexes,
  config: GraphViewConfig,
  sectionsByHeading: Map<string, Map<string, string>>,
): string | null {
  const target = rawTarget.trim()
  const hashIdx = target.indexOf('#')
  const base = hashIdx >= 0 ? target.slice(0, hashIdx) : target
  const section = hashIdx >= 0 ? target.slice(hashIdx + 1) : null

  let hit: string | undefined =
    indexes.byIdentity.get(target) ?? indexes.byIdentity.get(base)

  if (hit === undefined) {
    const candidates = [base, `${base}.md`]
    for (const candidate of candidates) {
      const abs = isAbsolutePath(candidate) ? normalizePath(candidate) : normalizePath(joinPaths(dirnamePath(fromDoc.path), candidate))
      const found = indexes.byPath.get(abs)
      if (found !== undefined) {
        hit = found
        break
      }
    }
  }

  if (hit === undefined) {
    const found = indexes.byFileName.get(base.toLowerCase())
    if (found !== undefined && found !== AMBIGUOUS) hit = found
  }

  if (hit === undefined) return null

  if (section !== null && config.sectionNodes) {
    const sectionId = sectionsByHeading.get(hit)?.get(section)
    if (sectionId !== undefined) return sectionId
  }

  return hit
}

interface RawReference {
  docId: string
  doc: CorpusDocument
  rawTarget: string
  origin: GraphEdgeOrigin
  field?: string
  /** When true, the edge is emitted source<->target swapped (superseded-by's inversion). */
  invert: boolean
}

function collectRawReferences(documents: CorpusDocument[], config: GraphViewConfig, idByPath: Map<string, string>): RawReference[] {
  const raw: RawReference[] = []

  for (const doc of documents) {
    const docId = idByPath.get(doc.path)!

    for (const field of config.edgeFields) {
      for (const rawValue of toValueList(doc.frontMatter[field])) {
        const target = stripWikiBrackets(rawValue)
        raw.push({ docId, doc, rawTarget: target, origin: 'front-matter', field, invert: field === 'superseded-by' })
      }
    }
    for (const target of doc.wikiLinks) {
      raw.push({ docId, doc, rawTarget: target, origin: 'wikilink', invert: false })
    }
    for (const target of doc.markdownLinks) {
      raw.push({ docId, doc, rawTarget: target, origin: 'markdown-link', invert: false })
    }
  }

  return raw
}

export interface EdgeBuildResult {
  edges: GraphEdge[]
  dangling: DanglingReference[]
  danglingNodes: GraphNode[]
}

/** Build every edge and dangling reference from the corpus's four edge sources. */
export function buildEdges(
  documents: CorpusDocument[],
  config: GraphViewConfig,
  indexes: ReferenceIndexes,
  idByPath: Map<string, string>,
  sectionsByHeading: Map<string, Map<string, string>>,
  rootPathByNodeId: Map<string, string | undefined>,
  modifiedMsByNodeId: Map<string, number>,
): EdgeBuildResult {
  const raw = collectRawReferences(documents, config, idByPath)
  const edgesById = new Map<string, GraphEdge>()
  const dangling: DanglingReference[] = []
  const danglingNodesById = new Map<string, GraphNode>()

  for (const r of raw) {
    let targetId = resolveReference(r.rawTarget, r.doc, indexes, config, sectionsByHeading)
    let isDangling = false

    if (targetId === null) {
      isDangling = true
      const danglingId = `dangling:${r.docId}:${r.rawTarget}`
      if (!danglingNodesById.has(danglingId)) {
        danglingNodesById.set(danglingId, {
          id: danglingId,
          kind: 'dangling',
          label: r.rawTarget,
          frontMatter: {},
          sizeBytes: 0,
          modifiedMs: 0,
          degree: 0,
          community: -1,
          centrality: 0,
          orphan: false,
        })
      }
      dangling.push({
        sourceId: r.docId,
        sourcePath: r.doc.path,
        rawTarget: r.rawTarget,
        origin: r.origin,
        ...(r.field ? { field: r.field } : {}),
      })
      targetId = danglingId
    }

    if (targetId === r.docId) continue // a self-reference is not an edge

    const directed = r.field !== undefined && DIRECTED_FIELDS.has(r.field)
    const source = r.invert ? targetId : r.docId
    const target = r.invert ? r.docId : targetId

    const key = `${source}|${target}|${r.origin}|${r.field ?? ''}`
    const existing = edgesById.get(key)
    if (existing) {
      existing.multiplicity++
      continue
    }

    const sourceRoot = rootPathByNodeId.get(source)
    const targetRoot = rootPathByNodeId.get(target)
    const crossRoot = !isDangling && sourceRoot !== undefined && targetRoot !== undefined && sourceRoot !== targetRoot

    const sourceModified = modifiedMsByNodeId.get(source) ?? 0
    const targetModified = modifiedMsByNodeId.get(target) ?? 0

    edgesById.set(key, {
      id: key,
      source,
      target,
      directed,
      origin: r.origin,
      ...(r.field ? { field: r.field } : {}),
      multiplicity: 1,
      crossRoot,
      dangling: isDangling,
      recencyMs: Math.max(sourceModified, targetModified),
    })
  }

  return { edges: [...edgesById.values()], dangling, danglingNodes: [...danglingNodesById.values()] }
}

/** Build undirected group-membership edges. Never `crossRoot`. The member may be a document or a section node. */
export function buildGroupEdges(memberships: GroupMembership[]): GraphEdge[] {
  return memberships.map((m) => ({
    id: `${m.docId}|${m.groupId}|group|${m.field}`,
    source: m.docId,
    target: m.groupId,
    directed: false,
    origin: 'group' as const,
    field: m.field,
    multiplicity: 1,
    crossRoot: false,
    dangling: false,
    recencyMs: 0,
  }))
}

/**
 * Build undirected document-anchor edges. Never `crossRoot`. An anchor edge
 * is a mediated, incidental claim (the document sits here), which is why it
 * carries its own origin rather than borrowing `group`.
 */
export function buildAnchorEdges(memberships: AnchorMembership[]): GraphEdge[] {
  return memberships.map((m) => ({
    id: `${m.docId}|${m.anchorId}|anchor|${m.field}`,
    source: m.docId,
    target: m.anchorId,
    directed: false,
    origin: 'anchor' as const,
    field: m.field,
    multiplicity: 1,
    crossRoot: false,
    dangling: false,
    recencyMs: 0,
  }))
}

/** Build undirected document-section edges. Never `crossRoot`. */
export function buildSectionEdges(memberships: { docId: string; sectionId: string }[]): GraphEdge[] {
  return memberships.map((m) => ({
    id: `${m.docId}|${m.sectionId}|section|`,
    source: m.docId,
    target: m.sectionId,
    directed: false,
    origin: 'section' as const,
    multiplicity: 1,
    crossRoot: false,
    dangling: false,
    recencyMs: 0,
  }))
}
