/**
 * Graph model orchestration: `buildGraphModel(snapshot, config) -> { model, graph }`.
 *
 * Pure and synchronous — no disk, no IPC, no `electron` import. Runs in the
 * renderer directly on every corpus delta, which is why it lives in
 * `shared/` alongside `gitGraphLayout.ts` rather than in `main/`.
 */

import Graph from 'graphology'
import type { CorpusSnapshot } from './graph-corpus-types'
import type { GraphViewConfig } from './graph-view-types'
import type { GraphModel, GraphNode } from './graph-model-types'
import {
  buildDocumentNodes,
  buildGroupNodes,
  buildIndexes,
  buildSectionNodes,
  dedupeDocuments,
  resolveIdentities,
} from './graph-model-resolve'
import { buildEdges, buildAnchorEdges, buildGroupEdges, buildSectionEdges } from './graph-model-edges'
import { buildAnchorNodes } from './graph-model-anchors'
import { applyMetrics } from './graph-model-metrics'

export interface GraphModelLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
}

export interface BuildGraphModelResult {
  model: GraphModel
  graph: Graph
}

/** View-time choices that change the node set without a config change. */
export interface BuildGraphModelOptions {
  /** Which of `config.promotedFields` are drawn as anchor nodes on this build. Absent means none. */
  promotedFields?: ReadonlySet<string>
  /**
   * Which documents decompose into section nodes. Absent or null
   * decomposes every document; the Graph View passes the documents in
   * scope, because decomposing a whole corpus multiplies it by its heading
   * count and produces a graph that neither reads nor simulates.
   */
  sectionDocumentIds?: ReadonlySet<string> | null
}

const NO_PROMOTED: ReadonlySet<string> = new Set()

/**
 * Build a `GraphModel` and its backing `graphology` instance from a corpus
 * snapshot and the operator's field bindings. Never throws.
 */
export function buildGraphModel(
  snapshot: CorpusSnapshot,
  config: GraphViewConfig,
  logger?: GraphModelLogger,
  options: BuildGraphModelOptions = {},
): BuildGraphModelResult {
  const started = Date.now()

  const documents = dedupeDocuments(snapshot.documents)
  const { idByPath, collisions } = resolveIdentities(documents, config)

  const documentNodes = buildDocumentNodes(documents, config, idByPath)
  const sections = buildSectionNodes(documents, config, idByPath, options.sectionDocumentIds ?? null)
  const { nodes: sectionNodes, memberships: sectionMemberships, byHeading: sectionsByHeading } = sections
  const { nodes: groupNodes, memberships: groupMemberships, movedToSections } = buildGroupNodes(documents, config, idByPath, sections)
  const { nodes: anchorNodes, memberships: anchorMemberships, suppressions: anchorSuppressions } = buildAnchorNodes(
    documents,
    config,
    idByPath,
    options.promotedFields ?? NO_PROMOTED,
  )

  const indexes = buildIndexes(documents, idByPath)

  const rootPathByNodeId = new Map<string, string | undefined>()
  const modifiedMsByNodeId = new Map<string, number>()
  for (const n of documentNodes) {
    rootPathByNodeId.set(n.id, n.rootPath)
    modifiedMsByNodeId.set(n.id, n.modifiedMs)
  }
  for (const n of sectionNodes) {
    // A section node's root follows its owning document, so a link
    // resolving to a section is cross-root exactly when the document is.
    const docId = n.id.split('#')[0]
    rootPathByNodeId.set(n.id, rootPathByNodeId.get(docId))
    modifiedMsByNodeId.set(n.id, n.modifiedMs)
  }

  const { edges: refEdges, dangling, danglingNodes } = buildEdges(
    documents,
    config,
    indexes,
    idByPath,
    sectionsByHeading,
    rootPathByNodeId,
    modifiedMsByNodeId,
  )
  const groupEdges = buildGroupEdges(groupMemberships)
  const anchorEdges = buildAnchorEdges(anchorMemberships)
  const sectionEdges = buildSectionEdges(sectionMemberships)

  const nodes: GraphNode[] = [...documentNodes, ...groupNodes, ...anchorNodes, ...sectionNodes, ...danglingNodes]
  const edges = [...refEdges, ...groupEdges, ...anchorEdges, ...sectionEdges]

  const graph = new Graph({ multi: true, type: 'mixed' })
  for (const n of nodes) graph.addNode(n.id)
  for (const e of edges) {
    if (e.directed) {
      graph.addDirectedEdgeWithKey(e.id, e.source, e.target)
    } else {
      graph.addUndirectedEdgeWithKey(e.id, e.source, e.target)
    }
  }

  const centralityMethod = applyMetrics(graph, nodes)

  const discoveredFields = new Set<string>()
  for (const doc of documents) {
    for (const key of Object.keys(doc.frontMatter)) discoveredFields.add(key)
  }

  const model: GraphModel = {
    nodes,
    edges,
    dangling,
    anchorSuppressions,
    discoveredFields: [...discoveredFields].sort(),
    identityCollisions: collisions,
    centralityMethod,
  }

  for (const s of anchorSuppressions) {
    logger?.debug('graph_view: anchor suppressed', { field: s.field, value: s.value ?? 'whole-property', documentCount: s.documentCount, reason: s.reason })
  }
  if (sections.unmatchedDeclarations > 0) {
    logger?.debug('graph_view: section topic declarations unmatched', { count: sections.unmatchedDeclarations, field: config.sectionTopicsField })
  }
  logger?.debug('graph_view: model built', {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    danglingCount: dangling.length,
    groupNodeCount: groupNodes.length,
    anchorNodeCount: anchorNodes.length,
    anchorSuppressionCount: anchorSuppressions.length,
    promotedFields: [...(options.promotedFields ?? NO_PROMOTED)].join(','),
    sectionNodeCount: sectionNodes.length,
    sectionTopicMoves: movedToSections,
    identityCollisionCount: collisions.length,
    centralityMethod,
    durationMs: Date.now() - started,
  })

  return { model, graph }
}
