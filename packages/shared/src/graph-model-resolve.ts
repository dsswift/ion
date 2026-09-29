/**
 * Graph model resolution: identity, label, group and section node
 * construction, plus the three lookup indexes edge resolution needs.
 *
 * Every rule here follows the program manifest's fixed resolution order
 * (`.workbench/gh-397-metadata-driven-graph-view/specs/04-graph-model.md`).
 * No field name is hardcoded: every read goes through `config.identityField`,
 * `config.labelField`, `config.groupFields`, `config.sectionTopicsField`.
 */

import type { CorpusDocument } from './graph-corpus-types'
import type { GraphViewConfig } from './graph-view-types'
import type { GraphNode, IdentityCollision } from './graph-model-types'

/** A scalar value coerced to a trimmed string, or `null` when not scalar/blank. */
export function coerceScalar(v: unknown): string | null {
  if (typeof v === 'string') {
    const trimmed = v.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString()
  return null
}

/** A scalar or list value expanded to a list of coerced strings, empties dropped. */
export function toValueList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(coerceScalar).filter((s): s is string => s !== null)
  }
  const single = coerceScalar(v)
  return single !== null ? [single] : []
}

/**
 * De-duplicate documents by `path`, keeping the entry whose `rootPath` is
 * longest (the most specific configured root). This resolves the
 * intentional nested-root duplication child 02's scanner produces.
 */
export function dedupeDocuments(documents: CorpusDocument[]): CorpusDocument[] {
  const byPath = new Map<string, CorpusDocument>()
  for (const doc of documents) {
    const existing = byPath.get(doc.path)
    if (!existing || doc.rootPath.length > existing.rootPath.length) {
      byPath.set(doc.path, doc)
    }
  }
  return [...byPath.values()]
}

export interface IdentityResolution {
  /** Document path -> resolved node id. */
  idByPath: Map<string, string>
  collisions: IdentityCollision[]
}

/**
 * Resolve every document's identity in scan order. The first document to
 * claim an identity value keeps it; every later claimant falls back to its
 * own path and is recorded as a collision. A document is NEVER merged or
 * dropped.
 */
export function resolveIdentities(documents: CorpusDocument[], config: GraphViewConfig): IdentityResolution {
  const claimed = new Map<string, string>() // identity value -> winner path
  const idByPath = new Map<string, string>()
  const collisionByIdentity = new Map<string, IdentityCollision>()

  for (const doc of documents) {
    const raw = coerceScalar(doc.frontMatter[config.identityField])
    if (raw === null) {
      idByPath.set(doc.path, doc.path)
      continue
    }
    const winner = claimed.get(raw)
    if (winner === undefined) {
      claimed.set(raw, doc.path)
      idByPath.set(doc.path, raw)
      continue
    }
    idByPath.set(doc.path, doc.path)
    const existing = collisionByIdentity.get(raw)
    if (existing) {
      existing.loserPaths.push(doc.path)
    } else {
      collisionByIdentity.set(raw, { identity: raw, winnerPath: winner, loserPaths: [doc.path] })
    }
  }

  return { idByPath, collisions: [...collisionByIdentity.values()] }
}

/** Resolve a document's label independently of identity, falling back to its filename. */
export function resolveLabel(doc: CorpusDocument, config: GraphViewConfig): string {
  return coerceScalar(doc.frontMatter[config.labelField]) ?? doc.fileName
}

export const AMBIGUOUS = Symbol('ambiguous')

export interface ReferenceIndexes {
  byIdentity: Map<string, string>
  byPath: Map<string, string>
  byFileName: Map<string, string | typeof AMBIGUOUS>
}

/** Build the identity, path, and filename lookup indexes edge resolution needs. */
export function buildIndexes(documents: CorpusDocument[], idByPath: Map<string, string>): ReferenceIndexes {
  const byIdentity = new Map<string, string>()
  const byPath = new Map<string, string>()
  const byFileName = new Map<string, string | typeof AMBIGUOUS>()

  for (const doc of documents) {
    const nodeId = idByPath.get(doc.path)!
    byIdentity.set(nodeId, nodeId)
    byPath.set(doc.path, nodeId)
    const key = doc.fileName.toLowerCase()
    if (byFileName.has(key) && byFileName.get(key) !== nodeId) {
      byFileName.set(key, AMBIGUOUS)
    } else if (!byFileName.has(key)) {
      byFileName.set(key, nodeId)
    }
  }

  return { byIdentity, byPath, byFileName }
}

export interface GroupMembership {
  /** The document or section node carrying the value. */
  docId: string
  groupId: string
  field: string
}

export interface GroupResult {
  nodes: GraphNode[]
  /** One record per (member, group) pair; converted to edges by graph-model-edges. */
  memberships: GroupMembership[]
  /**
   * Document-level memberships withheld because one of the document's own
   * sections declared the same value: the section carries the subject, so
   * the container does not also assert it. Counted for the build log.
   */
  movedToSections: number
}

/**
 * Build group nodes and membership records from `config.groupFields`.
 *
 * A group node exists once per distinct value of a content-descriptive field
 * and connects every document carrying that value. When section nodes are
 * on, a section that declares a value takes that value over from its
 * parent: the document-to-group edge is withheld for exactly the values its
 * sections carry, so a container document does not fabricate co-occurrence
 * among the subjects of its unrelated parts.
 */
export function buildGroupNodes(
  documents: CorpusDocument[],
  config: GraphViewConfig,
  idByPath: Map<string, string>,
  sections: SectionResult = EMPTY_SECTIONS,
): GroupResult {
  const nodes: GraphNode[] = []
  const seen = new Set<string>()
  const memberships: GroupMembership[] = []
  let movedToSections = 0

  const add = (memberId: string, field: string, value: string): void => {
    const groupId = `group:${field}:${value}`
    if (!seen.has(groupId)) {
      seen.add(groupId)
      nodes.push({
        id: groupId,
        kind: 'group',
        label: value,
        frontMatter: {},
        sizeBytes: 0,
        modifiedMs: 0,
        degree: 0,
        community: -1,
        centrality: 0,
        orphan: false,
      })
    }
    memberships.push({ docId: memberId, groupId, field })
  }

  for (const field of config.groupFields) {
    for (const doc of documents) {
      const docId = idByPath.get(doc.path)!
      const declaredBySections = sections.declaredByDoc.get(docId)?.get(field)
      for (const value of toValueList(doc.frontMatter[field])) {
        if (declaredBySections?.has(value)) {
          movedToSections++
          continue
        }
        add(docId, field, value)
      }
    }
    for (const section of sections.nodes) {
      for (const value of toValueList(section.frontMatter[field])) add(section.id, field, value)
    }
  }

  return { nodes, memberships, movedToSections }
}

export interface SectionResult {
  nodes: GraphNode[]
  /** `{ docId, sectionId }` per document-section pair. */
  memberships: { docId: string; sectionId: string }[]
  /**
   * Document id -> heading text -> the FIRST section node with that heading.
   * A body link to `doc#Heading` names a heading, never an ordinal, so it
   * resolves to the first repetition.
   */
  byHeading: Map<string, Map<string, string>>
  /** Document id -> group field -> the values its sections declared. Read by `buildGroupNodes`. */
  declaredByDoc: Map<string, Map<string, Set<string>>>
  /** Sections whose declared topics named a heading the document does not have. Logged, never fatal. */
  unmatchedDeclarations: number
}

const EMPTY_SECTIONS: SectionResult = { nodes: [], memberships: [], byHeading: new Map(), declaredByDoc: new Map(), unmatchedDeclarations: 0 }

/**
 * A section's identity is its parent's identity, its heading text, and its
 * ordinal among identical heading texts in that document. The ordinal is
 * not optional: a container repeats a heading routinely, and heading text
 * alone would merge every repetition into one node. The identity is derived
 * at read time and never persisted (see `views/saved-views.ts`).
 */
export function sectionNodeId(docId: string, heading: string, ordinal: number): string {
  return `${docId}#${heading}#${ordinal}`
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The per-section topic declarations a document's front matter carries under
 * `config.sectionTopicsField`: a list of mappings naming a `heading`, an
 * optional 1-based `ordinal`, and the field values that section is about.
 * Keyed by `heading#ordinal`; a malformed entry is skipped.
 */
function sectionDeclarations(doc: CorpusDocument, config: GraphViewConfig): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const raw = doc.frontMatter[config.sectionTopicsField]
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue
    const heading = coerceScalar(entry.heading)
    if (heading === null) continue
    const ordinalRaw = typeof entry.ordinal === 'number' && Number.isInteger(entry.ordinal) && entry.ordinal >= 1 ? entry.ordinal : 1
    const { heading: _h, ordinal: _o, ...bag } = entry
    out.set(`${heading}#${ordinalRaw}`, bag)
  }
  return out
}

/**
 * Build section nodes when `config.sectionNodes` is true. Off by default.
 * Each section node carries as its `frontMatter` exactly the topics its
 * declaration gave it, so hover, encoding, and filters treat a section like
 * any other node, and `buildGroupNodes` reads the same bag for its edges.
 */
export function buildSectionNodes(
  documents: CorpusDocument[],
  config: GraphViewConfig,
  idByPath: Map<string, string>,
  /**
   * Restricts decomposition to these document ids. Sections multiply a
   * corpus by the number of headings it carries, so decomposing all of it
   * produces a graph that cannot be read or simulated; the caller passes
   * the documents actually in view. Null decomposes every document, which
   * is what a caller with no scope of its own (a test, an export) wants.
   */
  onlyDocumentIds: ReadonlySet<string> | null = null,
): SectionResult {
  const nodes: GraphNode[] = []
  const memberships: SectionResult['memberships'] = []
  const byHeading = new Map<string, Map<string, string>>()
  const declaredByDoc = new Map<string, Map<string, Set<string>>>()
  let unmatchedDeclarations = 0
  if (!config.sectionNodes) return { nodes, memberships, byHeading, declaredByDoc, unmatchedDeclarations }

  for (const doc of documents) {
    const docId = idByPath.get(doc.path)!
    if (onlyDocumentIds && !onlyDocumentIds.has(docId)) continue
    const declarations = sectionDeclarations(doc, config)
    const seenHeadings = new Map<string, number>()
    const headings = new Map<string, string>()
    byHeading.set(docId, headings)

    for (const heading of doc.sections) {
      const ordinal = (seenHeadings.get(heading) ?? 0) + 1
      seenHeadings.set(heading, ordinal)
      const sectionId = sectionNodeId(docId, heading, ordinal)
      if (ordinal === 1) headings.set(heading, sectionId)

      const declared = declarations.get(`${heading}#${ordinal}`) ?? {}
      declarations.delete(`${heading}#${ordinal}`)
      for (const field of config.groupFields) {
        const values = toValueList(declared[field])
        if (values.length === 0) continue
        let byField = declaredByDoc.get(docId)
        if (!byField) {
          byField = new Map()
          declaredByDoc.set(docId, byField)
        }
        let set = byField.get(field)
        if (!set) {
          set = new Set()
          byField.set(field, set)
        }
        for (const v of values) set.add(v)
      }

      nodes.push({
        id: sectionId,
        kind: 'section',
        label: heading,
        frontMatter: declared,
        sizeBytes: 0,
        modifiedMs: doc.modifiedMs,
        degree: 0,
        community: -1,
        centrality: 0,
        orphan: false,
      })
      memberships.push({ docId, sectionId })
    }
    unmatchedDeclarations += declarations.size
  }

  return { nodes, memberships, byHeading, declaredByDoc, unmatchedDeclarations }
}

/** Build one `kind: 'document'` node per (de-duplicated) document. */
export function buildDocumentNodes(documents: CorpusDocument[], config: GraphViewConfig, idByPath: Map<string, string>): GraphNode[] {
  return documents.map((doc) => ({
    id: idByPath.get(doc.path)!,
    kind: 'document' as const,
    label: resolveLabel(doc, config),
    path: doc.path,
    rootPath: doc.rootPath,
    frontMatter: doc.frontMatter,
    sizeBytes: doc.sizeBytes,
    modifiedMs: doc.modifiedMs,
    degree: 0,
    community: -1,
    centrality: 0,
    orphan: false,
  }))
}
