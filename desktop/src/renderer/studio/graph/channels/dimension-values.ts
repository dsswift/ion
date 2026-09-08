/**
 * Dimension value extraction: read a raw value for any `ChannelDimension`
 * from a node or an edge. An edge dimension on a node channel (or vice
 * versa) is UNKNOWN, not an error — `undefined` flows through to the
 * scale's fixed unknown treatment.
 *
 * `rarity` and `overlap` are corpus-wide statistics, so their inputs are
 * cached per `GraphModel` instance in a `WeakMap`. A `GraphModel` is always
 * a fresh object per build or delta (`buildGraphModel` never mutates one in
 * place), so the cache invalidates itself the moment a new model replaces
 * the old one — there is no manual invalidation to get wrong.
 */

import type { ChannelDimension } from '../../../../shared/graph-view-types'
import type { GraphEdge, GraphModel, GraphNode } from '../../../../shared/graph-model-types'

/** Read a dimension's raw value from a node. An edge dimension is always undefined here. */
export function nodeValue(node: GraphNode, dimension: ChannelDimension): unknown {
  switch (dimension.source) {
    case 'frontMatter':
      return node.frontMatter[dimension.field]
    case 'structural':
      switch (dimension.metric) {
        case 'degree':
          return node.degree
        case 'community':
          return node.community
        case 'centrality':
          return node.centrality
        case 'orphan':
          return node.orphan
      }
      break
    case 'mechanical':
      switch (dimension.property) {
        case 'path':
          return node.path
        case 'root':
          return node.rootPath
        case 'sizeBytes':
          return node.sizeBytes
        case 'modifiedMs':
          return node.modifiedMs
      }
      break
    case 'edge':
      return undefined
  }
  return undefined
}

const fieldFrequencyCache = new WeakMap<GraphModel, Map<string, number>>()

function fieldFrequencies(model: GraphModel): Map<string, number> {
  const cached = fieldFrequencyCache.get(model)
  if (cached) return cached
  const freq = new Map<string, number>()
  for (const edge of model.edges) {
    const key = edge.field ?? edge.origin
    freq.set(key, (freq.get(key) ?? 0) + 1)
  }
  fieldFrequencyCache.set(model, freq)
  return freq
}

/** Inverse corpus frequency of the edge's source field (or origin, for a body link). */
export function rarity(edge: GraphEdge, model: GraphModel): number {
  const freq = fieldFrequencies(model)
  const key = edge.field ?? edge.origin
  const count = freq.get(key) ?? 1
  return 1 / count
}

const groupMembershipCache = new WeakMap<GraphModel, Map<string, Set<string>>>()

function groupMembershipByNode(model: GraphModel): Map<string, Set<string>> {
  const cached = groupMembershipCache.get(model)
  if (cached) return cached
  const byNode = new Map<string, Set<string>>()
  for (const edge of model.edges) {
    if (edge.origin !== 'group') continue
    if (!byNode.has(edge.source)) byNode.set(edge.source, new Set())
    byNode.get(edge.source)!.add(edge.target)
  }
  groupMembershipCache.set(model, byNode)
  return byNode
}

/**
 * Count of shared group memberships between an edge's two endpoints. Zero
 * when neither endpoint belongs to any group node — which is exactly what
 * `groupFields: []` produces, so this is a valid constant domain rather
 * than a special case.
 */
export function overlap(edge: GraphEdge, model: GraphModel): number {
  const byNode = groupMembershipByNode(model)
  const sourceGroups = byNode.get(edge.source)
  const targetGroups = byNode.get(edge.target)
  if (!sourceGroups || !targetGroups) return 0
  let count = 0
  for (const g of sourceGroups) if (targetGroups.has(g)) count++
  return count
}

/** Read a dimension's raw value from an edge. A node-only dimension is always undefined here. */
export function edgeValue(edge: GraphEdge, model: GraphModel, dimension: ChannelDimension): unknown {
  if (dimension.source !== 'edge') return undefined
  switch (dimension.metric) {
    case 'multiplicity':
      return edge.multiplicity
    case 'recency':
      return edge.recencyMs
    case 'rarity':
      return rarity(edge, model)
    case 'overlap':
      return overlap(edge, model)
    case 'crossRoot':
      return edge.crossRoot
    case 'origin':
      return edge.origin
    case 'field':
      // A body link has no field; its origin stands in so every edge has a value.
      return edge.field ?? edge.origin
  }
}
