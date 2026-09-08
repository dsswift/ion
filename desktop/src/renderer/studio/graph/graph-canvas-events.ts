/**
 * Pointer interaction on the graph stage: click, double-click, hover,
 * right-click, and edge hover. Extracted from GraphCanvas so the canvas
 * file stays under the size cap; nothing here is reusable elsewhere.
 *
 * Interaction model (analytical-first, per the design): plain click
 * selects and opens the inspector; Shift+click adds to or removes from the
 * selection; double-click drills in (Shift+double-click collapses an
 * expansion); Cmd/Ctrl+click opens the underlying file; right-click opens
 * the context menu. Hover is the primary reading gesture: the moment the
 * pointer enters a node its neighbourhood stays lit and the rest fades,
 * with no camera move; Quick Peek still waits its delay.
 */

import type Sigma from 'sigma'
import { rDebug } from '../../rendererLogger'
import { useGraphStore } from './graph-store'
import type { NodeDragHandle } from './graph-canvas-drag'

const HOVER_DELAY_MS = 400

export interface StageInteractionDeps {
  drag: NodeDragHandle
  /** The stage-to-overlay scale, so a stage point lands under the same pixel in the sibling overlay layer. */
  stageScale(): number
  /** A cluster node was clicked: the canvas frames its members once the expanded graph is on stage. */
  onClusterOpened(community: number): void
}

/** Attach every pointer handler. Returns a teardown for the hover timer; sigma's own listeners die with the instance. */
export function attachStageInteraction(sigma: Sigma, deps: StageInteractionDeps): () => void {
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  const clearHoverTimer = (): void => {
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = null
  }
  const stagePoint = (node: string): { x: number; y: number } => {
    const g = sigma.getGraph()
    const at = sigma.graphToViewport({ x: g.getNodeAttribute(node, 'x'), y: g.getNodeAttribute(node, 'y') })
    const scale = deps.stageScale()
    return { x: at.x * scale, y: at.y * scale }
  }

  // Every click navigates as well as selects: a plain click glides the
  // camera to the node (keeping the zoom), a click on a collapsed cluster
  // opens it and zooms to its members, and a double-click drills in —
  // into the node's neighborhood from corpus scope, one node wider from
  // inside one. Sigma's own double-click zoom is suppressed so the drill
  // is the only thing that happens.
  sigma.on('clickNode', ({ node, event }) => {
    const store = useGraphStore.getState()
    store.closeContextMenu()
    const g = sigma.getGraph()
    if (g.getNodeAttribute(node, 'kind') === 'cluster') {
      const community = g.getNodeAttribute(node, 'community') as number
      deps.onClusterOpened(community)
      store.expandCommunity(community)
      return
    }
    const modified = event.original.metaKey || event.original.ctrlKey
    if (modified) {
      store.requestOpenFile(node)
      return
    }
    // Shift+click extends the selection; a plain click replaces it and
    // centres on it.
    if (event.original.shiftKey) {
      store.toggleNodeSelection(node)
    } else {
      store.selectNode(node)
      store.requestCamera({ kind: 'center-node', nodeId: node })
    }
    rDebug('graph_view', 'graph_view: node selected', { nodeId: node, kind: g.getNodeAttribute(node, 'kind'), degree: g.getNodeAttribute(node, 'degree'), additive: event.original.shiftKey })
  })
  sigma.on('clickStage', () => {
    const store = useGraphStore.getState()
    store.closeContextMenu()
    store.selectNode(null)
  })
  sigma.on('doubleClickNode', ({ node, event }) => {
    event.preventSigmaDefault()
    if (sigma.getGraph().getNodeAttribute(node, 'kind') === 'cluster') return
    const store = useGraphStore.getState()
    if (event.original.shiftKey) store.collapseNodeScope(node)
    else store.drillInto(node)
  })
  sigma.on('rightClickNode', ({ node, event }) => {
    event.preventSigmaDefault()
    event.original.preventDefault()
    const scale = deps.stageScale()
    useGraphStore.getState().openContextMenu(node, { x: event.x * scale, y: event.y * scale })
  })
  sigma.on('rightClickStage', ({ event }) => {
    event.preventSigmaDefault()
    event.original.preventDefault()
    const scale = deps.stageScale()
    useGraphStore.getState().openContextMenu(null, { x: event.x * scale, y: event.y * scale })
  })

  sigma.on('enterNode', ({ node }) => {
    if (deps.drag.dragging()) return
    const store = useGraphStore.getState()
    store.setHoverNode(node)
    clearHoverTimer()
    hoverTimer = setTimeout(() => {
      if (!sigma.getGraph().hasNode(node)) return
      useGraphStore.getState().setQuickPeek(node, stagePoint(node))
    }, HOVER_DELAY_MS)
  })
  sigma.on('leaveNode', () => {
    clearHoverTimer()
    const store = useGraphStore.getState()
    store.setHoverNode(null)
    store.setQuickPeek(null)
  })
  // An edge answers to the pointer so the operator can read which field or
  // link produced it. Sigma reports an edge only while no node is hovered.
  sigma.on('enterEdge', ({ edge }) => {
    if (deps.drag.dragging()) return
    useGraphStore.getState().setQuickPeekEdge(edge)
  })
  sigma.on('leaveEdge', () => {
    useGraphStore.getState().setQuickPeekEdge(null)
  })

  return clearHoverTimer
}
