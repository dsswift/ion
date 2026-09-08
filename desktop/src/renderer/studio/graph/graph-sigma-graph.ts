/**
 * Model → graphology instance sync: add / merge / drop, keyed by node and
 * edge id, never a rebuild. Existing `x`/`y` on THIS instance are preserved
 * across a sync, and a node absent from it is restored from the caller's
 * `positions` map before it falls back to a fresh placement.
 *
 * Those are two different continuity mechanisms and both are load-bearing:
 * the merge covers a re-sync of the same instance, while `positions` is the
 * only thing that carries a settled layout across a rebuild, which hands
 * back a brand-new instance — `harvestPositions` below is what fills it.
 */

import Graph from 'graphology'
import type { GraphModel, GraphNode } from '../../../shared/graph-model-types'
import type { CoarsenPlan } from './coarsen/coarsen'
import { syntheticClusterNodeId } from './coarsen/coarsen'
import { nodeRenderSize } from './graph-node-size'

const JITTER_RADIUS = 100
const EMPTY_PINNED: ReadonlySet<string> = new Set()

/**
 * A small random offset, applied to every fallback placement so that nodes
 * with no positioned neighbour never land exactly on top of one another (or
 * of each other). ForceAtlas2 computes repulsion from inter-node distance;
 * colocated nodes divide by zero and the resulting NaN corrupts every
 * position it touches, which is what crashes Sigma's mount ("Coordinates of
 * node ... are invalid") on a corpus's first-ever layout, when the
 * `positions` map is empty and most nodes fall through to this fallback.
 */
function jitter(): { x: number; y: number } {
  const angle = Math.random() * Math.PI * 2
  const r = Math.random() * JITTER_RADIUS
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r }
}

/** Place a newly-appeared node near the centroid of its resolved neighbours, or a jittered origin. */
export function placeNewNode(graph: Graph, nodeId: string): { x: number; y: number } {
  if (!graph.hasNode(nodeId)) return jitter()
  const neighbors = graph.neighbors(nodeId)
  if (neighbors.length === 0) return jitter()

  let sumX = 0
  let sumY = 0
  let count = 0
  for (const n of neighbors) {
    if (graph.hasNode(n) && graph.hasNodeAttribute(n, 'x')) {
      sumX += graph.getNodeAttribute(n, 'x') as number
      sumY += graph.getNodeAttribute(n, 'y') as number
      count++
    }
  }
  if (count === 0) return jitter()
  const centroid = { x: sumX / count, y: sumY / count }
  const offset = jitter()
  return { x: centroid.x + offset.x * 0.1, y: centroid.y + offset.y * 0.1 }
}

/**
 * `size` is carried on the graph itself, not left to the reducer alone: the
 * overlap resolver needs each node's drawn radius before any reducer has
 * run, and Sigma falls back to this attribute for any frame where a reducer
 * is not installed. It matches the reducer's unbound-channel size exactly
 * (both call `nodeRenderSize`), so the two can never drift.
 */
function nodeAttrs(n: GraphNode, pinned: boolean): Record<string, unknown> {
  return {
    // ForceAtlas2 leaves a node with `fixed: true` where it is.
    fixed: pinned,
    size: nodeRenderSize(n.kind, n.degree),
    label: n.label,
    kind: n.kind,
    degree: n.degree,
    community: n.community,
    centrality: n.centrality,
    orphan: n.orphan,
    rootPath: n.rootPath,
    frontMatter: n.frontMatter,
  }
}

/**
 * A coordinate read off a graphology node may be absent entirely (a node
 * added bare by `buildGraphModel`), which is why the input is partial.
 */
function isFiniteXY(pos: { x?: number; y?: number } | undefined | null): pos is { x: number; y: number } {
  return !!pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)
}

/** Where a rejected non-finite position was found, for the caller's log line. */
export type InvalidPositionOrigin = 'stored' | 'merge-preserved'

/**
 * Sync a graphology instance to match `model`. Every node and edge present
 * in the model is added (new) or merged (existing, preserving `x`/`y`);
 * anything in the graph but no longer in the model is dropped.
 *
 * Every position, whether freshly assigned, restored from `positions`, or
 * preserved across a merge, is validated as finite before it reaches Sigma.
 * A non-finite value is repaired in place (jittered like a new node) and
 * reported via `onInvalidPosition` rather than left to crash Sigma's mount —
 * this is the self-healing half of the fix for the corpus-wide NaN placement
 * bug; jittering only new placements left an already-corrupted node's x/y
 * frozen forever, since a `merge` never touches an existing node's position.
 */
export function syncSigmaGraph(
  graph: Graph,
  model: GraphModel,
  positions: Map<string, { x: number; y: number }>,
  onInvalidPosition?: (nodeId: string, origin: InvalidPositionOrigin, pos: { x?: number; y?: number } | undefined) => void,
  pinned: ReadonlySet<string> = EMPTY_PINNED,
): void {
  const seenNodes = new Set<string>()

  for (const n of model.nodes) {
    seenNodes.add(n.id)
    const attrs = nodeAttrs(n, pinned.has(n.id))
    const stored = positions.get(n.id)
    if (stored !== undefined && !isFiniteXY(stored)) onInvalidPosition?.(n.id, 'stored', stored)

    if (!graph.hasNode(n.id)) {
      const pos = isFiniteXY(stored) ? stored : placeNewNode(graph, n.id)
      graph.addNode(n.id, { ...attrs, x: pos.x, y: pos.y })
      continue
    }

    const existing = {
      x: graph.getNodeAttribute(n.id, 'x') as number | undefined,
      y: graph.getNodeAttribute(n.id, 'y') as number | undefined,
    }
    if (isFiniteXY(existing)) {
      graph.mergeNodeAttributes(n.id, attrs)
      continue
    }

    // A node can exist here with no coordinate at all: `buildGraphModel`
    // adds every node bare, so on a rebuild EVERY node lands in this branch
    // with x/y undefined. That is a structural placeholder, not corruption —
    // reporting it would drown the real signal, and it must consult the
    // stored position before any fallback, or a rebuild discards the whole
    // settled layout. A value that is present but non-finite IS corruption
    // and is still reported.
    const corrupted = existing.x !== undefined || existing.y !== undefined
    if (corrupted) onInvalidPosition?.(n.id, 'merge-preserved', existing)
    const pos = isFiniteXY(stored) ? stored : placeNewNode(graph, n.id)
    graph.mergeNodeAttributes(n.id, { ...attrs, x: pos.x, y: pos.y })
  }

  for (const id of graph.nodes()) {
    if (!seenNodes.has(id)) graph.dropNode(id)
  }

  const seenEdges = new Set<string>()
  for (const e of model.edges) {
    seenEdges.add(e.id)
    const attrs = { directed: e.directed, dangling: e.dangling, multiplicity: e.multiplicity, crossRoot: e.crossRoot, recencyMs: e.recencyMs, origin: e.origin }
    if (graph.hasEdge(e.id)) {
      graph.mergeEdgeAttributes(e.id, attrs)
    } else if (graph.hasNode(e.source) && graph.hasNode(e.target)) {
      if (e.directed) graph.addDirectedEdgeWithKey(e.id, e.source, e.target, attrs)
      else graph.addUndirectedEdgeWithKey(e.id, e.source, e.target, attrs)
    }
  }

  for (const id of graph.edges()) {
    if (!seenEdges.has(id)) graph.dropEdge(id)
  }
}

/**
 * Harvest every laid-out position off the live graphology instance into the
 * store's position map.
 *
 * A rebuild does not reuse the graph — `buildGraphModel` returns a fresh
 * instance — so `positions` is the ONLY channel by which a node's coordinate
 * survives one. Before this existed the map held dragged nodes and nothing
 * else, which meant a corpus delta (any file save) dropped the whole settled
 * layout and re-seeded every node on the fallback jitter circle, with no
 * layout restart to recover: the graph collapsed into a blob on save.
 *
 * Synthetic cluster nodes are skipped — they are a render-layer artifact of
 * coarsening, recomputed from their members' centroid on every plan.
 */
export function harvestPositions(graph: Graph | null, positions: Map<string, { x: number; y: number }>): Map<string, { x: number; y: number }> {
  const carried = new Map(positions)
  if (!graph) return carried
  graph.forEachNode((id, attrs) => {
    if (attrs.kind === 'cluster') return
    const x = attrs.x as number
    const y = attrs.y as number
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    carried.set(id, { x, y })
  })
  return carried
}

/**
 * Build the graph Sigma should RENDER for a coarsening plan: a new instance
 * holding every uncollapsed node, one synthetic node per collapsed
 * community, and every edge rewritten onto those synthetic endpoints.
 *
 * It returns a new instance rather than mutating the source, and the caller
 * hands it to `sigma.setGraph`, because Sigma re-indexes its ENTIRE graph
 * synchronously on each node or edge DROP — `refresh()` with no partial
 * graph clears both indices and re-adds every node and edge, running the
 * reducers over all of them. Collapsing eleven communities in place meant
 * roughly four thousand dropped entities, so roughly four thousand full
 * re-indexations of a 2282-node graph: about twenty million reducer calls
 * for one wheel tick. That is the zoom-out freeze, measured at 2438ms in
 * the report's log after the reducers were indexed, and unbounded before.
 * A swapped graph is one re-indexation.
 *
 * Building off to the side also keeps the source graph pristine, so the
 * model sync no longer has to restore hundreds of collapsed members before
 * every recompute.
 */
export function buildCoarsenedGraph(source: Graph, plan: CoarsenPlan): Graph {
  const memberToCluster = new Map<string, string>()
  for (const [community, entry] of plan.collapsed) {
    const clusterId = syntheticClusterNodeId(community)
    for (const memberId of entry.memberIds) memberToCluster.set(memberId, clusterId)
  }

  const rendered = new Graph({ multi: false, type: 'mixed' })

  source.forEachNode((id, attrs) => {
    if (memberToCluster.has(id)) return
    rendered.addNode(id, { ...attrs })
  })

  for (const [community, entry] of plan.collapsed) {
    const clusterId = syntheticClusterNodeId(community)
    rendered.addNode(clusterId, {
      kind: 'cluster',
      label: `${entry.memberIds.length} documents`,
      x: entry.centroid.x,
      y: entry.centroid.y,
      degree: 0,
      memberCount: entry.memberIds.length,
      size: nodeRenderSize('cluster', 0, entry.memberIds.length),
      community,
      centrality: 0,
      orphan: false,
    })
  }

  source.forEachEdge((edgeId, attrs, sourceId, targetId) => {
    const from = memberToCluster.get(sourceId) ?? sourceId
    const to = memberToCluster.get(targetId) ?? targetId
    // An edge wholly inside one collapsed community has nothing left to
    // connect, and a duplicate between the same pair of endpoints would
    // draw as one line anyway.
    if (from === to) return
    if (!rendered.hasNode(from) || !rendered.hasNode(to)) return
    if (rendered.hasEdge(from, to)) return
    const key = from === sourceId && to === targetId ? edgeId : `${from}|${to}`
    if (attrs.directed === true) rendered.addDirectedEdgeWithKey(key, from, to, { ...attrs })
    else rendered.addUndirectedEdgeWithKey(key, from, to, { ...attrs })
  })

  return rendered
}
