/**
 * Node dragging on the graph stage. Extracted from GraphCanvas so the
 * canvas file stays under the size cap; nothing here is reusable elsewhere.
 *
 * A press on a node is only a candidate drag until the pointer has moved
 * past `DRAG_START_PX`; a click (or half of a double-click) never touches
 * the simulation. A graph that slides the moment it is touched reads as
 * unstable, and a double-click that woke the layout twice made the whole
 * neighbourhood drift under the cursor.
 *
 * A drag is CONFINED. Only the grabbed node's near neighbourhood is free to
 * move while the hand is on it, and on release only that set plus the
 * dropped node's neighbours settles. An earlier version let the whole graph
 * move during the drag and then decided what to settle by measuring which
 * nodes had moved — but a free simulation moves every node by more than any
 * epsilon, so the "local" settle freed 2191 of 2192 nodes on every drop and
 * the picture slid for seconds after each release. Confining the run makes
 * the settle set known by construction rather than inferred.
 */

import type Graph from 'graphology'
import type Sigma from 'sigma'
import { rDebug } from '../../rendererLogger'
import { neighborhood } from './scope/neighborhood'
import { useGraphStore } from './graph-store'
import type { LayoutEngine, LayoutRunOptions } from './graph-layout'

/** A press becomes a drag only once the pointer has travelled this far, in screen pixels. */
export const DRAG_START_PX = 4
/**
 * How far from the grabbed node the simulation stays live during a drag,
 * in hops. Two reaches the nodes the link forces actually pull and the
 * nodes those push aside; beyond that the forces the drag introduces are
 * already too weak to move anything visibly, and holding those nodes is
 * what keeps the rest of the picture still under the hand.
 */
export const DRAG_CONFINE_DEPTH = 2

/**
 * The nodes free to move while `node` is being dragged: its neighbourhood
 * to `DRAG_CONFINE_DEPTH`, minus the node itself (the hand holds it) and
 * minus anything pinned.
 */
export function dragSetFor(graph: Graph, node: string, pinned: ReadonlySet<string>): Set<string> {
  const free = neighborhood(graph, node, DRAG_CONFINE_DEPTH)
  free.delete(node)
  for (const id of pinned) free.delete(id)
  return free
}

/**
 * The nodes a drop leaves free to settle: everything the drag let move,
 * plus the dropped node's neighbours where it landed (it may have been
 * carried far from where the drag set was computed). The dropped node
 * itself is NOT free — it stays where the hand left it — and neither is
 * anything pinned or anything the drag never touched, so the settle is
 * local and the rest of the picture holds still.
 */
export function settleSetForDrop(graph: Graph, dropped: string, dragFree: ReadonlySet<string>, pinned: ReadonlySet<string>): Set<string> {
  const free = new Set(dragFree)
  if (graph.hasNode(dropped)) for (const neighbour of graph.neighbors(dropped)) free.add(neighbour)
  free.delete(dropped)
  for (const id of pinned) free.delete(id)
  return free
}

export interface NodeDragDeps {
  /** The source graph the simulation runs on; a coarsened stage renders a different one. */
  graph: Graph
  ensureEngine(): LayoutEngine
  getEngine(): LayoutEngine | null
  setNodePositions(entries: Map<string, { x: number; y: number }>): void
  redrawHull(): void
}

export interface NodeDragHandle {
  /** The node under the hand, or null when nothing is being dragged. */
  dragging(): string | null
}

export function attachNodeDrag(sigma: Sigma, deps: NodeDragDeps): NodeDragHandle {
  let dragged: string | null = null
  // A drag is a disturbance to a live simulation, not a copy of the hand.
  // The grabbed node is held at the cursor (fixed for the worker, its
  // position restored on every write-back) and the simulation wakes for its
  // neighbourhood, so its neighbours are pulled by the real link forces and
  // whatever is in the way is pushed by real repulsion. Everything outside
  // that neighbourhood is held. On release the node is let go (unless
  // pinned) and the settle runs over the same set plus what it now touches.
  //
  // A coarsened stage renders a separate graph, so a drag there moves the
  // drawn node only; the simulation lives on the source graph.
  const simulated = (): boolean => sigma.getGraph() === deps.graph
  // A press on a node is only a candidate drag until the pointer moves
  // past the dead zone; a click never touches the simulation.
  let pressed: { node: string; x: number; y: number } | null = null
  // The confinement in force for this drag. The same object is handed to
  // every reheat, so the engine can tell "still this drag" from a new one.
  let dragRun: LayoutRunOptions | null = null
  sigma.on('downNode', (e) => {
    pressed = { node: e.node, x: e.event.x, y: e.event.y }
  })
  const beginDrag = (node: string): void => {
    dragged = node
    const g = sigma.getGraph()
    g.setNodeAttribute(node, 'highlighted', true)
    // Sigma re-fits the graph's extent to the viewport on every frame, so
    // dragging a node past the current extent would rescale everything
    // else under the cursor. Freezing the bounding box for the duration of
    // the drag is what keeps the grabbed node under the pointer.
    if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox())
    if (simulated()) {
      const pinned = useGraphStore.getState().pinnedNodeIds
      dragRun = { free: dragSetFor(g, node, pinned), pinned }
      g.setNodeAttribute(node, 'fixed', true)
      const engine = deps.ensureEngine()
      engine.hold(node, { x: g.getNodeAttribute(node, 'x') as number, y: g.getNodeAttribute(node, 'y') as number })
      engine.run('drag', dragRun)
      rDebug('graph_view', 'graph_view: drag confined', { nodeId: node, freeCount: dragRun.free.size, nodeCount: g.order, depth: DRAG_CONFINE_DEPTH })
    }
    rDebug('graph_view', 'graph_view: drag started', { nodeId: node, simulated: simulated() })
  }
  sigma.on('moveBody', ({ event }) => {
    if (pressed && !dragged) {
      if (Math.hypot(event.x - pressed.x, event.y - pressed.y) < DRAG_START_PX) return
      beginDrag(pressed.node)
    }
    if (!dragged) return
    const g = sigma.getGraph()
    if (!g.hasNode(dragged)) return
    const at = sigma.viewportToGraph(event)
    g.setNodeAttribute(dragged, 'x', at.x)
    g.setNodeAttribute(dragged, 'y', at.y)
    const engine = deps.getEngine()
    if (simulated() && engine && dragRun) {
      engine.hold(dragged, at)
      engine.run('drag', dragRun)
    }
    // Without this the same pointer movement ALSO pans the camera, which
    // moves the stage under the node by exactly as much as the node moved
    // across it — the node appears pinned and the graph appears to pan,
    // which is precisely "I can pan and zoom but I cannot drag nodes".
    event.preventSigmaDefault()
    event.original.preventDefault()
    event.original.stopPropagation()
  })
  const stopDrag = (): void => {
    pressed = null
    const node = dragged
    if (!node) return
    const g = sigma.getGraph()
    if (g.hasNode(node)) {
      g.removeNodeAttribute(node, 'highlighted')
      if (simulated()) {
        // Let go into a LOCAL settle: the dropped node stays where the hand
        // left it and only what the drag let move, plus what the node now
        // touches, is free to find a resting place nearby (see
        // `settleSetForDrop`). Everything else is held, so the picture does
        // not slide. The engine releases the held nodes to their pinned
        // state when the settle cools.
        deps.setNodePositions(new Map([[node, { x: g.getNodeAttribute(node, 'x') as number, y: g.getNodeAttribute(node, 'y') as number }]]))
        const engine = deps.getEngine()
        if (engine) {
          const pinned = useGraphStore.getState().pinnedNodeIds
          const free = settleSetForDrop(g, node, dragRun?.free ?? new Set(), pinned)
          engine.hold(null)
          engine.run('drop', { free, pinned })
          rDebug('graph_view', 'graph_view: drop settle confined', { nodeId: node, freeCount: free.size, nodeCount: g.order })
        }
      }
    }
    dragged = null
    dragRun = null
    sigma.setCustomBBox(null)
    deps.redrawHull()
    rDebug('graph_view', 'graph_view: node dropped', { nodeId: node, simulated: simulated() })
  }
  sigma.getMouseCaptor().on('mouseup', stopDrag)
  sigma.getMouseCaptor().on('mouseleave', stopDrag)
  return { dragging: () => dragged }
}
