/**
 * Structural metrics: degree, orphan detection, Louvain community
 * assignment, and centrality — betweenness under 2000 nodes, degree
 * centrality above. The threshold is a stated, observable approximation:
 * `centralityMethod` records which branch ran rather than silently
 * substituting one for the other.
 */

import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { centrality } from 'graphology-metrics'
import type { GraphNode } from './graph-model-types'

const BETWEENNESS_NODE_CAP = 2000

/**
 * Louvain community detection is conceptually undirected — "which nodes
 * cluster together" does not depend on edge direction — and
 * `graphology-communities-louvain` refuses to run on a graph carrying both
 * directed and undirected edges (a "true mixed graph"), which the model's
 * directed supersession edges alongside undirected association edges
 * produce routinely. Project onto a same-node, all-undirected multi-graph
 * for the assignment step only; the caller's `graph` (and every other
 * metric) keeps its real directedness.
 */
function buildUndirectedProjection(graph: Graph): Graph {
  const projection = new Graph({ multi: true, type: 'undirected' })
  graph.forEachNode((node) => projection.addNode(node))
  graph.forEachEdge((edge, _attrs, source, target) => {
    if (!projection.hasEdge(edge)) projection.addUndirectedEdgeWithKey(edge, source, target)
  })
  return projection
}

/**
 * Compute degree, orphan status, community assignment, and centrality for
 * every node in `nodes`, mutating each in place. Returns which centrality
 * method was used.
 */
export function applyMetrics(graph: Graph, nodes: GraphNode[]): 'betweenness' | 'degree' {
  for (const n of nodes) {
    n.degree = graph.hasNode(n.id) ? graph.degree(n.id) : 0
  }
  for (const n of nodes) {
    n.orphan = n.kind === 'document' && n.degree === 0
  }

  if (graph.size === 0) {
    for (const n of nodes) {
      n.community = 0
      n.centrality = 0
    }
    return 'degree'
  }

  const undirected = buildUndirectedProjection(graph)
  louvain.assign(undirected, { nodeCommunityAttribute: '__community' })
  for (const n of nodes) {
    if (undirected.hasNode(n.id)) {
      n.community = undirected.getNodeAttribute(n.id, '__community') as number
    } else {
      n.community = 0
    }
  }

  if (nodes.length > BETWEENNESS_NODE_CAP) {
    const scores = centrality.degree(graph)
    for (const n of nodes) n.centrality = graph.hasNode(n.id) ? (scores[n.id] ?? 0) : 0
    return 'degree'
  }

  const scores = centrality.betweenness(graph)
  for (const n of nodes) n.centrality = graph.hasNode(n.id) ? (scores[n.id] ?? 0) : 0
  return 'betweenness'
}
