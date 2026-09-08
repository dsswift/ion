/**
 * Projections from the graph store into the shapes the graph tools answer
 * with. Pure over `GraphState`; nothing here touches the store or the stage.
 *
 * Kept apart from the command handler so the summary an agent reads is one
 * function with one test, and so the handler file stays about sequencing.
 */
import type { GraphState } from './graph-store-types'
import type { ChannelDimension } from '../../../shared/graph-view-types'
import type { GraphToolNeighbor, GraphToolNode, GraphToolState } from '../../../shared/studio-graph-types'

/** The summary every successful command carries. */
export function buildGraphToolState(state: GraphState): GraphToolState {
  const bindings: Record<string, ChannelDimension> = {}
  for (const [channel, binding] of Object.entries(state.bindings)) {
    if (binding.dimension) bindings[channel] = binding.dimension
  }
  return {
    projectPath: state.projectPath ?? '',
    nodeCount: state.model?.nodes.length ?? 0,
    edgeCount: state.model?.edges.length ?? 0,
    visibleCount: state.visibleNodeIds.size,
    layoutState: state.layoutState,
    selectedNodeIds: [...state.selectedNodeIds],
    highlightedNodeIds: [...state.agentHighlightNodeIds],
    scope: { mode: state.scope.mode, anchorId: state.scope.anchorId, depth: state.scope.depth, direction: state.scope.direction ?? 'both' },
    filters: state.filters,
    bindings,
    savedViews: (state.config?.savedViews ?? []).map((view) => view.name),
    discoveredFields: state.model?.discoveredFields ?? [],
    cameraRatio: state.cameraRatio,
  }
}

/** One node as the tools describe it, or null when the model has no such id. */
export function describeNode(state: GraphState, id: string): GraphToolNode | null {
  const node = state.model?.nodes.find((n) => n.id === id)
  if (!node) return null
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    path: node.path ?? null,
    degree: node.degree,
    community: node.community,
    centrality: node.centrality,
    orphan: node.orphan,
    visible: state.visibleNodeIds.has(node.id),
  }
}

/** Every edge touching `id`, described from that node's side. */
export function neighborsOf(state: GraphState, id: string): GraphToolNeighbor[] {
  const model = state.model
  if (!model) return []
  const labels = new Map(model.nodes.map((n) => [n.id, n.label]))
  const neighbors: GraphToolNeighbor[] = []
  for (const edge of model.edges) {
    if (edge.source !== id && edge.target !== id) continue
    const otherId = edge.source === id ? edge.target : edge.source
    const direction: GraphToolNeighbor['direction'] = !edge.directed ? 'both' : edge.source === id ? 'out' : 'in'
    neighbors.push({
      id: otherId,
      label: labels.get(otherId) ?? otherId,
      direction,
      origin: edge.origin,
      ...(edge.field ? { field: edge.field } : {}),
    })
  }
  return neighbors
}
