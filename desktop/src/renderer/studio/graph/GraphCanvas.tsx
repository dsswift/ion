/**
 * GraphCanvas — sigma lifecycle, camera, and the simulation's lifecycle.
 *
 * The mount effect creates one `Sigma` instance bound to this component's
 * container and kills it on unmount. Camera-ratio changes drive level of
 * detail: past the threshold nodes draw as simple dots (`node-point`) and
 * only hubs keep a label; inside it, outlined discs with labels admitted
 * by rendered size (see `graph-label-priority.ts` and the reducer).
 *
 * Labels are themed and width-bounded here rather than left to Sigma's
 * defaults, which are built for a white page: black text, an unbounded
 * label width, an opaque white hover pill (see `graph-label-render.ts`).
 * The label grid cell is sized to the truncation width so Sigma's
 * one-label-per-cell budget corresponds to one label's worth of space.
 *
 * Registers the node programs (`graph-node-programs.ts`) so the shape
 * channel (child 06), border-tint cluster rendering (child 07), and the
 * overview LOD's dot rendering (above) all have a program behind their
 * `type` string — any type a reducer can emit must be registered or Sigma
 * throws "could not find a suitable program for node type" the moment
 * that type reaches it.
 *
 * Pointer interaction lives in `graph-canvas-events.ts`, dragging in
 * `graph-canvas-drag.ts`, the keyboard map in `graph-canvas-keys.ts`, and
 * the eased emphasis in `graph-canvas-emphasis.ts`. While anything is
 * selected, highlighted, or hovered, nodes outside its neighbourhood draw
 * dimmed, and the dimming fades in over a few frames.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import Sigma from 'sigma'
import type Graph from 'graphology'
import { communityColor } from './channels/categorical-palette'
import { withAlpha } from './color-alpha'
import { HULL_FILL_ALPHA, HULL_STROKE_ALPHA } from './cluster/hull-overlay'
import { useColors } from '../../theme'
import { rDebug, rWarn } from '../../rendererLogger'
import { createEdgeReducer, createNodeReducer, type LevelOfDetail } from './graph-reducers'
import { createCameraDetailTracker } from './graph-camera-detail'
import { buildChannelScales } from './channels/build-channel-scales'
import { attachHullOverlay, type HullOverlayHandle } from './cluster/hull-overlay'
import { computeCoarsening, isCoarsened, COARSEN_RATIO_THRESHOLD } from './coarsen/coarsen'
import { buildCoarsenedGraph, syncSigmaGraph } from './graph-sigma-graph'
import { createNodeLabelDrawer, createNodeHoverDrawer } from './graph-label-render'
import { createSigmaSettings } from './graph-sigma-settings'
import { seedPositions, type LayoutEngine } from './graph-layout'
import { createStageEngine } from './graph-canvas-engine'
import { attachNodeDrag } from './graph-canvas-drag'
import { attachStageInteraction } from './graph-canvas-events'
import { createEmphasisAnimator, type EmphasisAnimator } from './graph-canvas-emphasis'
import { handleGraphKey } from './graph-canvas-keys'
import { applyCameraRequest } from './graph-camera'
import { useGraphStore } from './graph-store'
import { usePreferencesStore } from '../../preferences'

const HULL_REDRAW_INTERVAL_MS = 80
/** A frame gap past this is a stall the operator can feel, and is logged with its state. */
const SLOW_FRAME_MS = 250

export interface GraphCanvasProps {
  graph: Graph
  /**
   * Receives the live sigma instance after mount and `null` on teardown, so
   * a sibling overlay (the minimap) can read the camera and graph without
   * the store holding a render-layer object.
   */
  onSigma?: (sigma: Sigma | null) => void
}

export function GraphCanvas({ graph, onSigma }: GraphCanvasProps): React.JSX.Element {
  // Read through a ref so a new callback identity never remounts sigma.
  const onSigmaRef = useRef(onSigma)
  onSigmaRef.current = onSigma
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const hullRef = useRef<HullOverlayHandle | null>(null)
  const layoutRef = useRef<LayoutEngine | null>(null)
  const emphasisRef = useRef<EmphasisAnimator | null>(null)
  /** A community whose cluster node was just clicked: zoom to its members once the expanded graph is on stage. */
  const pendingClusterFocusRef = useRef<number | null>(null)
  const colors = useColors()
  // The sigma instance and the hull overlay both outlive a theme change (the
  // mount effect is keyed on `graph` alone, since remounting would discard
  // the WebGL context and the camera). They read the live palette through
  // this ref rather than the value captured at mount.
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  const [lod, setLod] = useState<LevelOfDetail>('detail')
  // The camera ratio the label budget is built for, in half-octave steps:
  // coarse enough that a zoom rebuilds the reducer a handful of times, not
  // once per frame (see `quantizeLabelZoom`).
  const [labelZoom, setLabelZoom] = useState(1)
  const [webglError, setWebglError] = useState(false)
  const selectedNodeIds = useGraphStore((s) => s.selectedNodeIds)
  const agentHighlightNodeIds = useGraphStore((s) => s.agentHighlightNodeIds)
  const emphasisNodeIds = useGraphStore((s) => s.emphasisNodeIds)
  const hoverNodeId = useGraphStore((s) => s.hoverNodeId)
  const hoverEmphasisNodeIds = useGraphStore((s) => s.hoverEmphasisNodeIds)
  const pinnedNodeIds = useGraphStore((s) => s.pinnedNodeIds)
  const setNodePositions = useGraphStore((s) => s.setNodePositions)
  const model = useGraphStore((s) => s.model)
  const bindings = useGraphStore((s) => s.bindings)
  const visibleNodeIds = useGraphStore((s) => s.visibleNodeIds)
  const clusterRendering = useGraphStore((s) => s.clusterRendering)
  const setCameraRatio = useGraphStore((s) => s.setCameraRatio)
  const forces = useGraphStore((s) => s.forces)
  // The map is read through a ref, never subscribed to: subscribing would
  // re-run the sync on every settled-layout write-back, and that write-back
  // is what the convergence monitor watches, so the run would never settle.
  const positionsEpoch = useGraphStore((s) => s.positionsEpoch)
  const layoutState = useGraphStore((s) => s.layoutState)
  const setLayoutState = useGraphStore((s) => s.setLayoutState)
  const noteCameraApplied = useGraphStore((s) => s.noteCameraApplied)

  /**
   * One warm simulation per graph instance, created on first need (the
   * initial layout, or a drag on a graph that was rebuilt without one) and
   * killed with the sigma instance.
   */
  const ensureEngine = (): LayoutEngine => {
    layoutRef.current ??= createStageEngine({
      graph,
      getContainer: () => containerRef.current,
      getSigma: () => sigmaRef.current,
      getHull: () => hullRef.current,
      getPinned: () => useGraphStore.getState().pinnedNodeIds,
      getForces: () => useGraphStore.getState().forces,
      setLayoutState,
      setNodePositions,
    })
    return layoutRef.current
  }
  // Sigma reads its dimensions from `offsetWidth` (CSS pixels, unzoomed) but
  // reads pointer positions from `getBoundingClientRect` (zoomed). Under the
  // app's root `zoom` those two disagree by exactly the zoom factor, which
  // put every hit test off by 10% of the distance from the container's top
  // left corner — the node under the cursor was not the node Sigma thought
  // was under the cursor. Counter-zooming the stage makes the two agree,
  // the same fix TerminalInstance applies to xterm's canvas.
  const uiZoom = usePreferencesStore((s) => s.uiZoom)
  // Counter-zooming the stage also means a point inside it maps to the
  // surrounding overlay layer scaled by the same factor. The hover card is a
  // sibling of the stage, not a child, so its anchor is converted here at
  // the one place that knows both spaces.
  const stageScaleRef = useRef(1)
  stageScaleRef.current = uiZoom !== 1 ? 1 / uiZoom : 1

  const scales = useMemo(() => (model ? buildChannelScales(model, bindings, colors) : null), [model, bindings, colors])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let sigma: Sigma
    try {
      sigma = new Sigma(graph, container, createSigmaSettings(graph, colors))
    } catch (err) {
      rWarn('graph_view', 'graph_view: sigma mount failed', { error: String(err) })
      setWebglError(true)
      return
    }
    sigmaRef.current = sigma
    onSigmaRef.current?.(sigma)
    emphasisRef.current = createEmphasisAnimator(() => sigmaRef.current)
    hullRef.current = attachHullOverlay(sigma, container, () => useGraphStore.getState().visibleNodeIds, (community) => {
      const tint = communityColor(colorsRef.current, community)
      return { fill: withAlpha(tint, HULL_FILL_ALPHA), stroke: withAlpha(tint, HULL_STROKE_ALPHA) }
    })

    // Dragging lives in graph-canvas-drag.ts; the handle tells the hover
    // path whether a drag is in progress.
    const drag = attachNodeDrag(sigma, {
      graph,
      ensureEngine,
      getEngine: () => layoutRef.current,
      setNodePositions,
      redrawHull: () => hullRef.current?.redraw(),
    })
    const detachInteraction = attachStageInteraction(sigma, {
      drag,
      stageScale: () => stageScaleRef.current,
      onClusterOpened: (community) => {
        pendingClusterFocusRef.current = community
      },
    })

    const camera = sigma.getCamera()
    const trackDetail = createCameraDetailTracker({
      onLod: (nextLod, ratio) => {
        setLod(nextLod)
        rDebug('graph_view', 'graph_view: level of detail changed', { lod: nextLod, ratio })
      },
      onLabelZoom: (nextLabelZoom, ratio) => {
        setLabelZoom(nextLabelZoom)
        rDebug('graph_view', 'graph_view: label zoom step changed', { labelZoom: nextLabelZoom, ratio })
      },
    })
    const onCameraUpdated = (): void => {
      trackDetail(camera.ratio)
      setCameraRatio(camera.ratio)
      // The hull layer is repainted from `afterRender` below, throttled. A
      // camera change always schedules a render, so redrawing here as well
      // meant a full convex-hull pass per community on every frame of a
      // zoom — unthrottled, on the main thread.
    }
    camera.on('updated', onCameraUpdated)

    // Hulls are drawn on our own canvas, so they do not move when the
    // simulation moves nodes — only a Sigma frame tells us the picture
    // changed. Throttled, because a running simulation renders every frame
    // and a hull is a convex hull per community.
    let lastHullDraw = 0
    let renderStartedAt = 0
    // Time spent INSIDE a render, not the gap between two of them. Measuring
    // the gap reported every idle pause as a stall and buried the real ones.
    const onBeforeRender = (): void => {
      renderStartedAt = Date.now()
    }
    sigma.on('beforeRender', onBeforeRender)
    const onAfterRender = (): void => {
      const now = Date.now()
      const renderMs = renderStartedAt > 0 ? now - renderStartedAt : 0
      if (renderMs > SLOW_FRAME_MS) {
        rWarn('graph_view', 'graph_view: slow frame', {
          renderMs,
          cameraRatio: sigma.getCamera().ratio,
          nodeCount: sigma.getGraph().order,
          edgeCount: sigma.getGraph().size,
          coarsened: isCoarsened(sigma.getCamera().ratio),
        })
      }
      if (now - lastHullDraw < HULL_REDRAW_INTERVAL_MS) return
      lastHullDraw = now
      const hullStartedAt = Date.now()
      hullRef.current?.redraw()
      const hullMs = Date.now() - hullStartedAt
      if (hullMs > SLOW_FRAME_MS) rWarn('graph_view', 'graph_view: slow hull repaint', { hullMs, nodeCount: sigma.getGraph().order })
    }
    sigma.on('afterRender', onAfterRender)

    // Sigma only re-reads its container's size from inside `render()`, and a
    // closed panel schedules no render — which left the stage frozen at the
    // smaller size, drawing nothing past a hard horizontal edge until the
    // next pan. Observe the container and resize explicitly.
    const observer = new ResizeObserver(() => {
      sigma.resize()
      sigma.refresh()
      hullRef.current?.redraw()
    })
    observer.observe(container)

    return () => {
      detachInteraction()
      observer.disconnect()
      camera.off('updated', onCameraUpdated)
      sigma.off('afterRender', onAfterRender)
      sigma.off('beforeRender', onBeforeRender)
      layoutRef.current?.kill()
      layoutRef.current = null
      emphasisRef.current?.dispose()
      emphasisRef.current = null
      hullRef.current?.destroy()
      hullRef.current = null
      onSigmaRef.current?.(null)
      sigma.kill()
      sigmaRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  // The seeds are what the operator picked, what an agent pointed at, and
  // what the pointer is over; the emphasis is their neighbourhoods. Both go
  // to the fader, which eases every node's level toward the new target and
  // refreshes the stage per frame until it lands. A hover therefore costs
  // no reducer rebuild — the reducers read the fader's levels per call.
  useEffect(() => {
    const animator = emphasisRef.current
    if (!animator) return
    const seeds = new Set<string>([...selectedNodeIds, ...agentHighlightNodeIds, ...(hoverNodeId ? [hoverNodeId] : [])])
    const emphasis = seeds.size === 0 ? null : new Set<string>([...emphasisNodeIds, ...hoverEmphasisNodeIds, ...seeds])
    animator.retarget({ emphasis, seeds })
  }, [selectedNodeIds, agentHighlightNodeIds, emphasisNodeIds, hoverNodeId, hoverEmphasisNodeIds])

  useEffect(() => {
    const sigma = sigmaRef.current
    if (!sigma || !model || !scales) return
    // Sigma requires a reducer's return value to be "a total object" (see
    // graph-reducers.ts): a reducer bug that drops a required field (x/y)
    // throws synchronously here, outside React's render cycle, and would
    // otherwise crash the whole renderer with no recovery. Degrade to the
    // same fallback UI as a failed mount instead.
    // An agent highlight draws exactly like a selection: the reducers see
    // one `selected` set, and the store keeps the two apart only so a click
    // can clear one without the other. The levels come from the fader.
    const selected = agentHighlightNodeIds.size === 0 ? selectedNodeIds : new Set([...selectedNodeIds, ...agentHighlightNodeIds])
    const levels = emphasisRef.current?.fader
    const selection = { selected, emphasis: emphasisNodeIds, ...(levels ? { levels } : {}) }
    try {
      sigma.setSetting('nodeReducer', createNodeReducer(model, scales, bindings, colors, lod, selection, visibleNodeIds, clusterRendering, pinnedNodeIds, labelZoom))
      sigma.setSetting('edgeReducer', createEdgeReducer(model, scales, bindings, colors, selection))
      sigma.refresh()
      if (clusterRendering === 'hull') hullRef.current?.redraw()
    } catch (err) {
      rWarn('graph_view', 'graph_view: sigma reducer install failed', { error: String(err) })
      setWebglError(true)
    }
  }, [model, scales, bindings, colors, lod, labelZoom, selectedNodeIds, agentHighlightNodeIds, emphasisNodeIds, visibleNodeIds, clusterRendering, pinnedNodeIds])

  // Label appearance is installed at mount from the palette of the moment;
  // re-apply it whenever the operator switches theme, together with a hull
  // repaint, so the stage never keeps the previous theme's label color.
  useEffect(() => {
    const sigma = sigmaRef.current
    if (!sigma) return
    sigma.setSetting('labelColor', { color: colors.graphLabel })
    sigma.setSetting('defaultDrawNodeLabel', createNodeLabelDrawer(colors))
    sigma.setSetting('defaultDrawNodeHover', createNodeHoverDrawer(colors))
    sigma.refresh()
    hullRef.current?.redraw()
  }, [colors])

  // A force change reaches the warm engine and starts a run so the shape
  // follows the slider. Before the first layout there is no engine yet; the
  // initial run reads the store's forces when it is created.
  useEffect(() => {
    const engine = layoutRef.current
    if (!engine || graph.order === 0) return
    engine.setForces(forces)
    engine.run('forces')
  }, [forces, graph])

  // The simulation's lifecycle lives here, not in the store: seeding and
  // the overlap pass are both defined in viewport pixels, and the viewport
  // is a render-layer fact. The store asks for a layout ('requested'); this
  // effect seeds and starts the engine's initial run, and the engine
  // reports back. A confined request (`layoutFree`) skips seeding — the
  // sync already placed the new nodes beside their neighbours — and lets
  // only those nodes move.
  useEffect(() => {
    if (layoutState !== 'requested') return
    const container = containerRef.current
    if (!container) return

    const begin = (): boolean => {
      const rect = container.getBoundingClientRect()
      // This surface stays mounted at `display: none` while another surface
      // is active, so the container can have no size when a layout is
      // requested. Every pixel-denominated decision below would be
      // meaningless; wait for real geometry instead of guessing.
      if (rect.width <= 0 || rect.height <= 0) return false

      const { layoutFree, positions, pinnedNodeIds: pinned } = useGraphStore.getState()
      if (layoutFree) {
        rDebug('graph_view', 'graph_view: layout confined to additions', { nodeCount: graph.order, freeCount: layoutFree.size })
        ensureEngine().run('structure', { free: layoutFree, pinned })
        return true
      }
      const seeded = seedPositions(graph, new Set(positions.keys()))
      rDebug('graph_view', 'graph_view: layout seeded', { nodeCount: graph.order, seededNodes: seeded })
      ensureEngine().run('initial')
      return true
    }

    if (begin()) return
    rDebug('graph_view', 'graph_view: layout deferred, container has no size', { nodeCount: graph.order })
    const observer = new ResizeObserver(() => {
      if (begin()) observer.disconnect()
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutState, graph])

  // Camera commands arrive from the store by sequence number. One is applied
  // once, and only once the layout has settled — a fit computed against seed
  // positions would frame the wrong picture, so a request made while the
  // simulation runs waits for `settled` and is applied then.
  const cameraRequest = useGraphStore((s) => s.cameraRequest)
  const consumedCameraSeqRef = useRef(0)
  useEffect(() => {
    const sigma = sigmaRef.current
    if (!sigma || !cameraRequest) return
    if (cameraRequest.seq <= consumedCameraSeqRef.current) return
    if (layoutState === 'requested' || layoutState === 'running') {
      // Deferred, not dropped: this effect re-runs when layoutState leaves
      // the running pair, and the request is applied then. A request that
      // never resolves is a stuck camera, so the only way out of this
      // branch is a layout that ends — which `onCool` guarantees, and
      // which a parked session no longer claims to be inside.
      rDebug('graph_view', 'graph_view: camera request deferred', { kind: cameraRequest.kind, seq: cameraRequest.seq, layoutState })
      return
    }
    consumedCameraSeqRef.current = cameraRequest.seq
    const seq = cameraRequest.seq
    applyCameraRequest(sigma, cameraRequest, () => noteCameraApplied(seq))
  }, [cameraRequest, layoutState, noteCameraApplied])

  // A peek by node id. Same deferral rule as the camera: the node's stage
  // position is only meaningful once the layout has stopped moving it.
  const peekRequest = useGraphStore((s) => s.peekRequest)
  const setQuickPeek = useGraphStore((s) => s.setQuickPeek)
  const consumedPeekSeqRef = useRef(0)
  useEffect(() => {
    const sigma = sigmaRef.current
    if (!sigma || !peekRequest) return
    if (peekRequest.seq <= consumedPeekSeqRef.current) return
    if (layoutState === 'requested' || layoutState === 'running') {
      rDebug('graph_view', 'graph_view: peek request deferred', { nodeId: peekRequest.nodeId, seq: peekRequest.seq, layoutState })
      return
    }
    consumedPeekSeqRef.current = peekRequest.seq
    const g = sigma.getGraph()
    if (!g.hasNode(peekRequest.nodeId)) {
      rWarn('graph_view', 'graph_view: peek request had no target', { nodeId: peekRequest.nodeId, seq: peekRequest.seq })
      return
    }
    const at = sigma.graphToViewport({ x: g.getNodeAttribute(peekRequest.nodeId, 'x'), y: g.getNodeAttribute(peekRequest.nodeId, 'y') })
    const scale = stageScaleRef.current
    setQuickPeek(peekRequest.nodeId, { x: at.x * scale, y: at.y * scale })
    rDebug('graph_view', 'graph_view: peek request applied', { nodeId: peekRequest.nodeId, seq: peekRequest.seq })
  }, [peekRequest, layoutState, setQuickPeek])

  const cameraRatio = useGraphStore((s) => s.cameraRatio)
  const expandedCommunities = useGraphStore((s) => s.expandedCommunities)

  // Coarsening reads the camera as ONE bit (see `isCoarsened`), and this
  // effect keys on that bit — never on the raw ratio, which changes on
  // every camera frame.
  const coarsened = isCoarsened(cameraRatio)

  useEffect(() => {
    if (!model || !graph) return
    // Restore the full model onto the sigma graph first (undoing any prior
    // collapse), then apply the freshly computed plan on top. This keeps
    // coarsening a render-layer transform: the model instance itself is
    // never touched, and the store's model always reflects every document.
    const startedAt = Date.now()
    // The source graph always holds every document. Coarsening never
    // touches it — it produces a separate graph for Sigma to render, which
    // is swapped in whole (see `buildCoarsenedGraph`).
    const positions = useGraphStore.getState().positions
    syncSigmaGraph(graph, model, positions, undefined, pinnedNodeIds)
    const syncedAt = Date.now()
    const plan = computeCoarsening(model, visibleNodeIds, coarsened ? COARSEN_RATIO_THRESHOLD : 0, expandedCommunities, (id) => {
      const stored = positions.get(id)
      if (stored) return stored
      if (graph.hasNode(id)) return { x: graph.getNodeAttribute(id, 'x'), y: graph.getNodeAttribute(id, 'y') }
      return undefined
    })
    const rendered = plan.collapsed.size > 0 ? buildCoarsenedGraph(graph, plan) : graph
    const builtAt = Date.now()

    const sigma = sigmaRef.current
    if (sigma) {
      if (sigma.getGraph() === rendered) sigma.refresh()
      else sigma.setGraph(rendered)
      // A cluster the operator just opened: frame its members now that
      // they are on stage. Applied here rather than through the store so
      // the request cannot race the graph swap it depends on.
      const community = pendingClusterFocusRef.current
      if (community !== null) {
        pendingClusterFocusRef.current = null
        const members = model.nodes.filter((n) => n.community === community && visibleNodeIds.has(n.id)).map((n) => n.id)
        applyCameraRequest(sigma, { seq: 0, kind: 'fit-nodes', nodeIds: members })
      }
    }
    rDebug('graph_view', 'graph_view: coarsening applied', {
      coarsened,
      collapsedCommunities: plan.collapsed.size,
      sourceNodeCount: graph.order,
      renderedNodeCount: rendered.order,
      renderedEdgeCount: rendered.size,
      syncMs: syncedAt - startedAt,
      buildMs: builtAt - syncedAt,
      swapMs: Date.now() - builtAt,
    })
  }, [model, graph, visibleNodeIds, coarsened, expandedCommunities, positionsEpoch, pinnedNodeIds])

  if (webglError) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, fontSize: 12 }}>
        Graph rendering failed to start. Try reopening this tab.
      </div>
    )
  }

  // The keyboard map lives in graph-canvas-keys.ts. The container takes
  // focus on click so the keys reach it.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (handleGraphKey(e.key)) e.preventDefault()
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        outline: 'none',
        flex: 1,
        minHeight: 0,
        position: 'relative',
        // See the `uiZoom` note above: this cancels the root zoom for the
        // stage only, so Sigma's two coordinate sources agree and a click
        // lands on the node under the cursor. The graph is a canvas, not
        // text — it has no type to scale — so drawing it unzoomed costs
        // nothing an operator would notice.
        zoom: uiZoom !== 1 ? 1 / uiZoom : undefined,
      }}
    />
  )
}
