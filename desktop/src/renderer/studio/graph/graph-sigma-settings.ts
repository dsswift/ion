/**
 * The Sigma instance's settings for the graph stage: which programs draw
 * nodes and edges, how labels are budgeted and drawn, and the camera's
 * bounds. Built once per mount by `GraphCanvas`.
 *
 * Kept beside `GraphCanvas.tsx` rather than inside it so the canvas file
 * stays under the size cap and the settings can be read as one document.
 */

import type Graph from 'graphology'
import type { Settings } from 'sigma/settings'
import { EdgeArrowProgram, EdgeRectangleProgram } from 'sigma/rendering'
import EdgeCurveProgram, { EdgeCurvedArrowProgram } from '@sigma/edge-curve'
import { NODE_PROGRAM_CLASSES } from './graph-node-programs'
import { createNodeLabelDrawer, createNodeHoverDrawer, MAX_LABEL_WIDTH_PX } from './graph-label-render'
import { MAX_CAMERA_RATIO, MIN_CAMERA_RATIO } from './graph-camera'
import type { ColorPalette } from '../../theme-tokens'

const LABEL_FONT = 'system-ui, -apple-system, sans-serif'
const LABEL_SIZE_PX = 12
/**
 * A node drawn smaller than this on screen gets no label unless the
 * reducer forces one (a hub). Rendered size grows with zoom, so a leaf
 * earns its label by being looked at closely — the level-of-detail ramp
 * between "hubs only" and "everything" is this threshold, not a switch.
 */
const LABEL_RENDERED_SIZE_THRESHOLD_PX = 4
/**
 * Past this many edges, edges are dropped while the camera moves. Below
 * it a pan keeps the full picture: the blink of edges vanishing on every
 * drag is worse than the frame cost on a corpus this size.
 */
export const HIDE_EDGES_ON_MOVE_ABOVE = 4000
/**
 * Sigma's label grid admits `ceil(labelDensity / ratio²)` labels per cell —
 * at least one, always. So the cell, not the density, is what keeps labels
 * from colliding: size it to hold one truncated label plus the node it
 * belongs to.
 */
const LABEL_GRID_NODE_ALLOWANCE_PX = 60
const LABEL_GRID_CELL_PX = MAX_LABEL_WIDTH_PX + LABEL_GRID_NODE_ALLOWANCE_PX

/**
 * How a node's screen radius follows the camera: a size is divided by this
 * of the ratio, so zooming in by four doubles the node. Nodes grow like
 * features on a map as the operator comes in, and edges — one pixel at
 * every zoom — stop out-weighing them. Sigma's own default is this same
 * function; it is pinned here so the behaviour is a stated choice rather
 * than an inherited one.
 */
export const zoomToSizeRatio = (ratio: number): number => Math.sqrt(ratio)

/**
 * Every edge `type` the reducer can emit must have a program here. The
 * default is a straight line: a single edge between two nodes has nothing
 * to disambiguate, and straight lines cross less than arcs do. The curved
 * programs are kept for the pairs that need them — two nodes joined both
 * ways, or by more than one edge, draw as a lens rather than one line over
 * another (see `EDGE_CURVATURE` in the reducer).
 */
export const EDGE_PROGRAM_CLASSES = {
  line: EdgeRectangleProgram,
  arrow: EdgeArrowProgram,
  curve: EdgeCurveProgram,
  curvedArrow: EdgeCurvedArrowProgram,
}

export function createSigmaSettings(graph: Graph, colors: ColorPalette): Partial<Settings> {
  return {
    nodeProgramClasses: NODE_PROGRAM_CLASSES,
    edgeProgramClasses: EDGE_PROGRAM_CLASSES,
    renderLabels: true,
    // Sigma admits `ceil(density / ratio²)` labels per grid cell, and the
    // grid is laid out at zoom 1. A density of 1 is one label per cell at
    // zoom 1 and four per cell at zoom 0.5, where each cell is twice as wide
    // on screen — level on-screen density as the camera comes in. Zooming
    // out the floor of one per cell would crowd the stage, which is why the
    // reducer thins the candidates instead (graph-label-priority.ts).
    labelDensity: 1,
    labelGridCellSize: LABEL_GRID_CELL_PX,
    labelRenderedSizeThreshold: LABEL_RENDERED_SIZE_THRESHOLD_PX,
    labelFont: LABEL_FONT,
    labelSize: LABEL_SIZE_PX,
    labelWeight: '500',
    labelColor: { color: colors.graphLabel },
    defaultDrawNodeLabel: createNodeLabelDrawer(colors),
    defaultDrawNodeHover: createNodeHoverDrawer(colors),
    hideEdgesOnMove: graph.size > HIDE_EDGES_ON_MOVE_ABOVE,
    // The node reducer raises the selected node's zIndex; without this
    // Sigma ignores the field entirely and selection can draw beneath its
    // own neighbours.
    zIndex: true,
    defaultNodeType: 'circle',
    defaultEdgeType: 'line',
    // Edges answer to the pointer so an operator can hover one to read
    // which field or link produced it (Quick Peek describes the edge).
    enableEdgeEvents: true,
    itemSizesReference: 'screen',
    zoomToSizeRatioFunction: zoomToSizeRatio,
    // An unbounded wheel has no floor or ceiling; both ends are places an
    // operator gets lost. The ceiling sits above the coarsening threshold
    // so zooming out still reaches the coarsened overview.
    minCameraRatio: MIN_CAMERA_RATIO,
    maxCameraRatio: MAX_CAMERA_RATIO,
    allowInvalidContainer: false,
  }
}
