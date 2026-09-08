/**
 * Node and edge reducers — the appearance seam. Every visual property is
 * computed at draw time by reading the bound channel's scale over the
 * node/edge's dimension value; rendering code contains no field names.
 *
 * A node's `kind` (document/group/anchor/section/dangling) is a STRUCTURAL
 * fact, not a bindable dimension — it never appears in the catalog. When a
 * channel is unbound, appearance falls back to the kind-based defaults
 * (dangling dimmed and smaller, group/anchor/section their own tint, an
 * anchor its own shape); when a channel IS bound, the scale takes over for
 * every node kind uniformly, because the operator's binding is a deliberate
 * choice that should not silently keep fighting a structural default
 * underneath.
 *
 * An edge's origin is likewise structural: a curated document link draws
 * at full strength, a node-mediated tie (through a topic or an anchor) and
 * a document's tie to its own section draw a step fainter, so a claim an
 * author made and a coincidence a shared node produced never read as the
 * same line. Binding the edge colour channel replaces that default.
 *
 * The LOD override stays ahead of the shape channel: at overview zoom every
 * node is a point regardless of binding, because that is a rendering-cost
 * decision, not an encoding one. Labels follow a priority, not the LOD
 * alone: a hub (see `graph-label-priority.ts`) is named at every zoom.
 */

import type { Attributes } from 'graphology-types'
import { nodeValue, edgeValue } from './channels/dimension-values'
import type { ChannelScales } from './channels/build-channel-scales'
import type { ColorPalette } from '../../theme-tokens'
import type { ChannelBindings } from '../../../shared/graph-view-types'
import { curatedOrigin, type GraphEdge, type GraphEdgeOrigin, type GraphModel } from '../../../shared/graph-model-types'
import { nodeRenderSize } from './graph-node-size'
import { mixColors, withAlpha } from './color-alpha'
import { degreeRanks, hubDegreeThreshold, labelEligibleCount, labelTier, LANDMARK_COUNT, type LabelTier } from './graph-label-priority'
import { OUTLINE_COLOR_ATTRIBUTE, RING_COLOR_ATTRIBUTE } from './graph-node-programs'
import { communityColor } from './channels/categorical-palette'
import type { EmphasisLevels } from './selection/emphasis-fade'

export type LevelOfDetail = 'overview' | 'detail'

/**
 * The active emphasis as the reducers see it. `selected` draws highlighted;
 * `emphasis` is the selected nodes plus their neighbours, and everything
 * outside it draws dimmed. `levels`, when present, supplies an eased
 * per-node strength (see `selection/emphasis-fade.ts`) so the dimming
 * fades in; without it the sets are read as binary. `null` means no
 * selection and no dimming.
 */
export interface SelectionEmphasis {
  selected: ReadonlySet<string>
  emphasis: ReadonlySet<string>
  levels?: EmphasisLevels
}

/**
 * Dimming darkens toward the stage background; it never drops alpha.
 *
 * Sigma blends premultiplied (`gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`),
 * so translucent lines STACK where they cross while opaque ones do not.
 * Dimming by alpha therefore inverts exactly where a graph is dense: one
 * lonely edge at 15% alpha nearly vanishes, but twenty crossing edges at
 * 15% compose to 1 - 0.85^20 ≈ 96% of the colour — indistinguishable from
 * an undimmed edge. Hovering one node then read as the whole graph lighting
 * up, when in truth 6% of it was emphasised and every tangled cluster had
 * simply refused to recede.
 *
 * Mixing toward the background reaches the same apparent brightness with a
 * fully opaque colour, so a dimmed region looks dimmed at any density.
 * (This is the same defect that made the resting edge tokens opaque; the
 * dimming path had reintroduced it.)
 *
 * Each constant is how much of the ORIGINAL colour survives at full dim.
 */
/** A node outside the emphasis set while a selection is active. */
export const DIMMED_NODE_ALPHA = 0.25
/** An edge touching no selected node while a selection is active. */
export const DIMMED_EDGE_ALPHA = 0.15
/** An orphan document (no links either way) recedes: this much of its colour and size. */
export const ORPHAN_ALPHA = 0.45

/**
 * Fade `color` toward the stage background. `keep` is the fraction of the
 * colour that survives, so it reads like the alpha it replaces: 1 is the
 * colour untouched, 0 is the background itself.
 *
 * `containerBg` is what `GraphSurface` paints the stage with, so mixing
 * toward it lands on the same apparent colour alpha would have produced
 * over it — without the alpha, and so without the stacking.
 */
function recede(color: string, keep: number, colors: ColorPalette): string {
  return mixColors(color, colors.containerBg, 1 - Math.min(1, Math.max(0, keep)))
}
export const ORPHAN_SIZE_FACTOR = 0.6
/** Curvature handed to the curved edge programs for a parallel or reciprocal pair; subtle enough that the pair still reads as two lines. */
export const EDGE_CURVATURE = 0.15
/** Below this level a dimmed node's label is withheld: a faded label is noise. */
const LABEL_LEVEL_THRESHOLD = 0.5

/** The binary reading of a selection, for a caller that has no fader. */
function binaryLevels(selection: SelectionEmphasis): EmphasisLevels {
  return {
    active: () => selection.selected.size > 0,
    node: (id) => (selection.emphasis.has(id) ? 1 : 0),
    seed: (id) => (selection.selected.has(id) ? 1 : 0),
  }
}

function levelsOf(selection: SelectionEmphasis | null): EmphasisLevels | null {
  if (!selection) return null
  const levels = selection.levels ?? binaryLevels(selection)
  return levels.active() ? levels : null
}

export interface NodeReducerResult extends Attributes {
  size: number
  color: string
  label: string
  type: string
  /** Which label treatment the drawer applies; hubs are forced past the grid budget. */
  labelTier: LabelTier
  forceLabel: boolean
  highlighted?: boolean
  zIndex?: number
  hidden?: boolean
}

export interface EdgeReducerResult {
  type: string
  size: number
  color: string
  curvature: number
  hidden?: boolean
}

/**
 * Origins whose edges are drawn ON DEMAND rather than always.
 *
 * A node-mediated tie is a star: one shared node joined to every document
 * carrying its value. On a real corpus, turning tag nodes on added 112
 * nodes and 15,968 edges — six times the corpus's own link count — and the
 * stage rendered as one white mass in which nothing, including the actual
 * document links underneath, could be read. Alpha does not save it; the
 * count is the problem.
 *
 * So the shared node keeps its job as an ATTRACTOR — the edges stay in the
 * graph, the simulation still pulls its members into a visible cluster,
 * and the hull still draws around them — while the lines themselves appear
 * only for what the operator is actually looking at. Grouping is shown by
 * position, which is what a shared value really means, and the membership
 * is shown on request.
 */
function drawnOnDemand(origin: GraphEdgeOrigin | undefined): boolean {
  return origin === 'group' || origin === 'anchor'
}

/**
 * Sigma calls a reducer once per node and once per edge on EVERY full
 * refresh, and a refresh is scheduled by every graph mutation — which means
 * every tick the layout worker writes back, every drag move, and every node
 * dropped or restored by coarsening.
 *
 * Looking an entity up with `Array.find` inside that call therefore costs
 * O(n) per call and O(n²) per frame: on a corpus of a couple of thousand
 * nodes and edges that is roughly fourteen million comparisons per refresh,
 * on the main thread. It is why zooming out far enough to trigger
 * coarsening — thousands of mutations at once — locked the application hard
 * enough to need a force quit. Index once, when the reducer is built.
 */
function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  const index = new Map<string, T>()
  for (const item of items) index.set(item.id, item)
  return index
}

function kindDefaultColor(kind: string, colors: ColorPalette): string {
  if (kind === 'dangling') return colors.graphNodeDangling
  if (kind === 'group') return colors.graphNodeGroup
  if (kind === 'anchor') return colors.graphNodeAnchor
  if (kind === 'section') return colors.graphNodeSection
  if (kind === 'cluster') return colors.graphNodeGroup
  return colors.graphNodeDefault
}

/** The unbound edge colour by origin: curated links full, mediated and structural ties a step fainter. */
function originDefaultColor(origin: GraphEdgeOrigin | undefined, dangling: boolean, colors: ColorPalette): string {
  if (dangling) return colors.graphEdgeDangling
  if (origin !== undefined && !curatedOrigin(origin)) return colors.graphEdgeMediated
  return colors.graphEdgeDefault
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`
}

/**
 * The node pairs joined by more than one edge (two directions, or two
 * fields). Only these draw curved: a lone edge has nothing to disambiguate,
 * and an arc crosses more of the stage than the line it replaces.
 */
export function parallelPairs(edges: GraphEdge[]): Set<string> {
  const counts = new Map<string, number>()
  for (const e of edges) {
    const key = pairKey(e.source, e.target)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const parallel = new Set<string>()
  for (const [key, count] of counts) if (count > 1) parallel.add(key)
  return parallel
}

/**
 * Create a node reducer reading the resolved scales. `model` and `scales`
 * are captured by reference at reducer-creation time; a new reducer is
 * created on every model rebuild or binding change, matching sigma's own
 * "call setSetting + refresh" convention.
 *
 * `visibleNodeIds` implements filtering + scope as one visibility pass: a
 * node outside the set draws `hidden: true`, which removes it from the
 * picture while leaving its model entry and stored position untouched — a
 * cleared filter restores it with no relayout. Sigma hides an edge whose
 * either endpoint is hidden, so no separate edge-visibility bookkeeping is
 * needed.
 */
export function createNodeReducer(
  model: GraphModel,
  scales: ChannelScales,
  bindings: ChannelBindings,
  colors: ColorPalette,
  lod: LevelOfDetail,
  selection: SelectionEmphasis | null,
  visibleNodeIds?: Set<string>,
  clusterRendering: 'hull' | 'border-tint' | 'off' = 'hull',
  pinnedNodeIds?: ReadonlySet<string>,
  /** The camera ratio the label budget is computed for (see `labelEligibleCount`); quantized by the caller. */
  labelZoom = 1,
): (id: string, data: Attributes) => NodeReducerResult {
  const nodeIndex = indexById(model.nodes)
  // Hubs and label ranks are decided once per reducer build over the
  // corpus's degrees, so the per-node call below is a lookup, not a scan.
  const hubThreshold = hubDegreeThreshold(model.nodes.map((n) => n.degree))
  const ranks = degreeRanks(model.nodes)
  const eligible = labelEligibleCount(Math.max(1, model.nodes.length), labelZoom)

  return (id, data) => {
    // Read per call, not per build: a fader's levels change every frame
    // while the reducer stays installed.
    const levels = levelsOf(selection)
    const label = typeof data.label === 'string' ? data.label : ''
    const kind = typeof data.kind === 'string' ? data.kind : 'document'
    const degree = typeof data.degree === 'number' ? data.degree : 0
    const node = nodeIndex.get(id)
    const orphan = kind === 'document' && data.orphan === true
    const community = typeof data.community === 'number' ? data.community : -1

    const boundColor = bindings.nodeColor.dimension && node
      ? String(scales.nodeColor.apply(nodeValue(node, bindings.nodeColor.dimension)))
      : kindDefaultColor(kind, colors)
    // An orphan recedes by alpha, never by hue: a bound colour still reads
    // through, and the operator can hide the ring outright via the filter
    // panel rather than have it shout at full strength.
    const color = orphan ? recede(boundColor, ORPHAN_ALPHA, colors) : boundColor

    const memberCount = typeof data.memberCount === 'number' ? data.memberCount : 0
    // A synthetic cluster node has no model entry, so a bound size channel
    // has no value to read for it: it keeps its member-count size either way.
    const boundSize = bindings.nodeSize.dimension && node
      ? Number(scales.nodeSize.apply(nodeValue(node, bindings.nodeSize.dimension)))
      : nodeRenderSize(kind, degree, memberCount)
    const size = orphan ? boundSize * ORPHAN_SIZE_FACTOR : boundSize
    // A cluster stands in for a community and is always a landmark.
    const tier: LabelTier = kind === 'cluster' ? 'hub' : labelTier(degree, hubThreshold)

    // An anchor is a third visual class: a square where documents and
    // topics are discs, so an ownership cluster is never read as a subject.
    let shapeType = lod === 'overview'
      ? 'point'
      : bindings.nodeShape.dimension && node
        ? String(scales.nodeShape.apply(nodeValue(node, bindings.nodeShape.dimension)))
        : kind === 'anchor'
          ? 'square'
          : 'circle'

    let ringColor = colors.graphNodeOutline
    if (clusterRendering === 'border-tint' && kind === 'document' && lod !== 'overview' && !bindings.nodeShape.dimension) {
      shapeType = 'border'
      ringColor = communityColor(colors, community)
    }
    // A pinned node is marked with the ring program when the shape channel is
    // free to show it; a bound shape channel keeps its encoding, and the
    // inspector's Pinned row carries the state instead.
    if (pinnedNodeIds?.has(id) && lod !== 'overview' && !bindings.nodeShape.dimension) {
      shapeType = 'border'
      ringColor = colors.graphLabelHub
    }

    // Sigma's contract: "this function must return a total object and won't
    // be merged" — spreading `data` first is what keeps x/y (and any other
    // attribute Sigma or our own event handlers read, e.g. `kind` for
    // clickNode's cluster check) alive across every reducer call. Building a
    // fresh object with only the visual fields silently dropped x/y on every
    // node, which crashed Sigma's cache build the instant the reducer was
    // installed ("could not find a valid position (x, y) for node ...").
    // Label candidacy is by degree rank against the zoom's budget: close
    // in every node is a candidate and the grid thins them; far out only
    // the best-connected few remain. A synthetic cluster stands in for a
    // whole community and always ranks first; a node the model does not
    // know ranks last. The landmarks — top-ranked hubs among the
    // candidates — are forced past the grid, so the corpus's structure is
    // always captioned, while a small corpus with no hubs forces nothing.
    const rank = kind === 'cluster' ? 0 : (ranks.get(id) ?? ranks.size)
    const labelled = rank < eligible
    const landmark = labelled && rank < LANDMARK_COUNT && tier === 'hub'
    const result: NodeReducerResult = {
      ...data,
      size,
      color,
      label: labelled ? label : '',
      labelTier: tier,
      forceLabel: landmark && !orphan,
      type: shapeType,
      [OUTLINE_COLOR_ATTRIBUTE]: colors.graphNodeOutline,
      [RING_COLOR_ATTRIBUTE]: ringColor,
      // A synthetic cluster node stands in for members the operator can
      // still see; it has no model entry, so it is not in the visibility
      // set and testing it against that set hid every collapsed community
      // outright — zooming out past the coarsening threshold made most of
      // the corpus disappear instead of summarising it.
      hidden: visibleNodeIds && kind !== 'cluster' ? !visibleNodeIds.has(id) : false,
    }

    if (!levels || kind === 'cluster') return result
    if (selection!.selected.has(id)) {
      return { ...result, highlighted: true, zIndex: 1 }
    }
    // Emphasis dims by alpha rather than swapping the color, so an encoded
    // color still reads through the dimming and a bound channel is never
    // overridden — only faded. The level eases in over a few frames; labels
    // go once a node is more dimmed than lit.
    const level = levels.node(id)
    if (level >= 1) return result
    const dimmed = recede(color, DIMMED_NODE_ALPHA + (1 - DIMMED_NODE_ALPHA) * level, colors)
    return level < LABEL_LEVEL_THRESHOLD ? { ...result, color: dimmed, label: '', forceLabel: false } : { ...result, color: dimmed }
  }
}

/** Create an edge reducer reading the resolved scales (color, thickness, opacity). Direction still decides arrow vs. line; parallel pairs curve. */
export function createEdgeReducer(
  model: GraphModel,
  scales: ChannelScales,
  bindings: ChannelBindings,
  colors: ColorPalette,
  selection: SelectionEmphasis | null = null,
): (id: string, data: Attributes) => EdgeReducerResult {
  const edgeIndex = indexById(model.edges)
  const parallel = parallelPairs(model.edges)

  return (id, data) => {
    const levels = levelsOf(selection)
    const edge = edgeIndex.get(id)
    const dangling = data.dangling === true
    const origin = typeof data.origin === 'string' ? (data.origin as GraphEdgeOrigin) : edge?.origin

    const color = bindings.edgeColor.dimension && edge
      ? String(scales.edgeColor.apply(edgeValue(edge, model, bindings.edgeColor.dimension)))
      : originDefaultColor(origin, dangling, colors)

    const size = bindings.edgeThickness.dimension && edge
      ? Number(scales.edgeThickness.apply(edgeValue(edge, model, bindings.edgeThickness.dimension)))
      : 1

    // Sigma has no per-edge opacity field, so the opacity channel rides the
    // color's alpha byte. Unbound, the palette token — opaque by design, so
    // twenty edges over one pixel are exactly as bright as one — stands.
    const opacityColor = bindings.edgeOpacity.dimension && edge
      ? withAlpha(color, Number(scales.edgeOpacity.apply(edgeValue(edge, model, bindings.edgeOpacity.dimension))))
      : color

    // An edge that touches a seed (a selected, highlighted, or hovered node)
    // is part of what the operator is reading; every other edge recedes. A
    // synthetic (coarsened) edge has no model entry and is left alone.
    let finalColor = opacityColor
    if (levels && edge) {
      const seed = Math.max(levels.seed(edge.source), levels.seed(edge.target))
      if (seed < 1) finalColor = recede(opacityColor, DIMMED_EDGE_ALPHA + (1 - DIMMED_EDGE_ALPHA) * seed, colors)
    }

    // A membership line is drawn when either of its ends is what the
    // operator is reading — the hovered or selected node, or a node an
    // agent pointed at. Hovering the shared node shows everything it
    // gathers; hovering a document shows which shared nodes claim it. With
    // nothing selected and nothing under the pointer there is no demand,
    // so none of them draw.
    const onDemand = drawnOnDemand(origin)
    const revealed = onDemand && levels !== null && edge !== undefined
      ? levels.seed(edge.source) > 0 || levels.seed(edge.target) > 0
      : false

    const curved = edge ? parallel.has(pairKey(edge.source, edge.target)) : false
    const directed = data.directed === true
    return {
      type: curved ? (directed ? 'curvedArrow' : 'curve') : directed ? 'arrow' : 'line',
      size,
      color: finalColor,
      curvature: curved ? EDGE_CURVATURE : 0,
      ...(onDemand && !revealed ? { hidden: true } : {}),
    }
  }
}
