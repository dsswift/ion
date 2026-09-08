/**
 * Hull overlay: shaded regions per community, drawn on a camera-synced
 * canvas layer that tracks pan and zoom. One canvas, not one element per
 * cluster — the design's explicit cost bound for this layer.
 *
 * Each region is the community's convex hull, padded and rounded (see
 * `hull-geometry.ts`) and tinted with the community's own categorical
 * colour at low alpha, so a region reads as a soft field behind its
 * members rather than a hard polygon cutting across the stage. A hull
 * too sparse to be a region is skipped.
 *
 * The canvas is PREPENDED to Sigma's container, not appended. Sigma's own
 * layers (edges, nodes, labels, hovers, mouse) carry no z-index and stack in
 * DOM order, so an appended overlay paints over every node and edge on the
 * stage — a hull is a background region and belongs underneath.
 *
 * Backing-store size tracks `devicePixelRatio` so hull edges are as sharp as
 * the WebGL layers they sit behind; the drawing code stays in CSS pixels,
 * which is the space `graphToViewport` returns.
 */

import type Sigma from 'sigma'
import { convexHull, paddedOutline, selectDrawableHulls, type HullCandidate, type Point } from './hull-geometry'

const MIN_HULL_MEMBERS = 3
/** Clearance between a member's centre and the region's edge, in CSS pixels. */
export const HULL_PADDING_PX = 18
export const HULL_FILL_ALPHA = 0.07
export const HULL_STROKE_ALPHA = 0.22

export interface HullOverlayHandle {
  /** Redraw from the current sigma graph state (call on camera 'updated' and on visibility change). */
  redraw(): void
  destroy(): void
}

export interface HullColors {
  fill: string
  stroke: string
}

/**
 * Attach a hull-overlay canvas as a sibling of sigma's container. Groups
 * currently-visible document nodes by community, skips communities with
 * fewer than `MIN_HULL_MEMBERS` (a hull needs a real polygon) and hulls
 * the sparse-region rule rejects, and fills each with the colours
 * `colorsFor(community)` returns.
 */
export function attachHullOverlay(
  sigma: Sigma,
  container: HTMLElement,
  getVisible: () => Set<string>,
  colorsFor: (community: number) => HullColors,
): HullOverlayHandle {
  const canvas = document.createElement('canvas')
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.pointerEvents = 'none'
  container.prepend(canvas)

  let cssWidth = 0
  let cssHeight = 0

  /**
   * Only touch the canvas when its size actually changed. Assigning
   * `canvas.width` reallocates the whole backing store even when the value
   * is unchanged — at device pixel ratio 2 on a full-window stage that is
   * tens of megabytes discarded and re-allocated on every repaint, which is
   * garbage-collector pressure the frame budget cannot absorb.
   */
  function resize(): void {
    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const width = Math.round(rect.width * dpr)
    const height = Math.round(rect.height * dpr)
    if (canvas.width === width && canvas.height === height) return
    cssWidth = rect.width
    cssHeight = rect.height
    canvas.width = width
    canvas.height = height
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
  }
  resize()

  function tracePadded(ctx: CanvasRenderingContext2D, hull: Point[]): void {
    const segments = paddedOutline(hull, HULL_PADDING_PX)
    if (segments.length === 0) return
    ctx.beginPath()
    ctx.moveTo(segments[0].from.x, segments[0].from.y)
    for (const segment of segments) {
      ctx.lineTo(segment.to.x, segment.to.y)
      // The arc sweeps from this edge's normal to the next edge's normal
      // around the shared vertex. Canvas arcs sweep clockwise in screen
      // space by default; whichever direction is the short way round is the
      // outside of the corner, and that is the one to take.
      let sweep = segment.endAngle - segment.startAngle
      while (sweep > Math.PI) sweep -= Math.PI * 2
      while (sweep < -Math.PI) sweep += Math.PI * 2
      ctx.arc(segment.center.x, segment.center.y, HULL_PADDING_PX, segment.startAngle, segment.startAngle + sweep, sweep < 0)
    }
    ctx.closePath()
  }

  function redraw(): void {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    resize()
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, cssHeight)

    const graph = sigma.getGraph()
    const visible = getVisible()
    const byCommunity = new Map<number, Point[]>()

    graph.forEachNode((id, attrs) => {
      if (!visible.has(id)) return
      if (attrs.kind !== 'document') return
      const community = typeof attrs.community === 'number' ? attrs.community : -1
      if (community < 0) return
      const viewportPos = sigma.graphToViewport({ x: attrs.x, y: attrs.y })
      if (!byCommunity.has(community)) byCommunity.set(community, [])
      byCommunity.get(community)!.push(viewportPos)
    })

    const candidates: HullCandidate<number>[] = []
    for (const [community, points] of byCommunity) {
      if (points.length < MIN_HULL_MEMBERS) continue
      const hull = convexHull(points)
      if (hull.length < 3) continue
      candidates.push({ hull, memberCount: points.length, tag: community })
    }

    ctx.lineWidth = 1
    ctx.lineJoin = 'round'
    for (const { hull, tag } of selectDrawableHulls(candidates)) {
      const colors = colorsFor(tag)
      ctx.fillStyle = colors.fill
      ctx.strokeStyle = colors.stroke
      tracePadded(ctx, hull)
      ctx.fill()
      ctx.stroke()
    }
  }

  return {
    redraw,
    destroy() {
      canvas.remove()
    },
  }
}
