/**
 * Minimap projection — pure geometry between graph space and the minimap's
 * pixel space. The graph's bounding box is fitted into the minimap with a
 * margin; the viewport is drawn as the rectangle those same corners land on.
 * The inverse mapping turns a click back into a graph point for the camera.
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface MinimapProjection {
  /** Every projected node, in minimap pixels. */
  dots: Point[]
  /** The stage's visible region in minimap pixels. May exceed the minimap when zoomed out past the graph. */
  viewportRect: Rect
  /** Graph units → minimap pixels. */
  scale: number
  /** Graph-space bounding box the projection fitted. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** Minimap pixel offset of the fitted box's top-left corner. */
  offset: Point
}

/** Pixels of margin inside the minimap edge. */
export const MINIMAP_MARGIN_PX = 6

/**
 * Fit `points` into `size` and project both them and the viewport corners.
 * Returns null when there is nothing to draw (no finite points).
 */
export function projectMinimap(points: Iterable<Point>, viewportCornersInGraph: Point[], size: Size, margin = MINIMAP_MARGIN_PX): MinimapProjection | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const finite: Point[] = []
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    finite.push(p)
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  if (finite.length === 0) return null

  const innerWidth = Math.max(1, size.width - 2 * margin)
  const innerHeight = Math.max(1, size.height - 2 * margin)
  const spanX = maxX - minX
  const spanY = maxY - minY
  // A single node (or a perfectly collinear set) has no extent on one axis;
  // fall back to a unit span so the scale stays finite and the dot lands centred.
  const scale = Math.min(innerWidth / (spanX > 0 ? spanX : 1), innerHeight / (spanY > 0 ? spanY : 1))
  const offset = {
    x: margin + (innerWidth - spanX * scale) / 2,
    y: margin + (innerHeight - spanY * scale) / 2,
  }
  const toMinimap = (p: Point): Point => ({ x: offset.x + (p.x - minX) * scale, y: offset.y + (p.y - minY) * scale })

  const dots = finite.map(toMinimap)

  const corners = viewportCornersInGraph.map(toMinimap)
  const vx = corners.map((c) => c.x)
  const vy = corners.map((c) => c.y)
  const viewportRect: Rect = {
    x: Math.min(...vx),
    y: Math.min(...vy),
    width: Math.max(...vx) - Math.min(...vx),
    height: Math.max(...vy) - Math.min(...vy),
  }

  return { dots, viewportRect, scale, bounds: { minX, minY, maxX, maxY }, offset }
}

/** Inverse of the projection: a minimap pixel back to graph space. */
export function minimapPointToGraph(point: Point, projection: MinimapProjection): Point {
  return {
    x: projection.bounds.minX + (point.x - projection.offset.x) / projection.scale,
    y: projection.bounds.minY + (point.y - projection.offset.y) / projection.scale,
  }
}

/**
 * True when the viewport rectangle already contains every dot — the stage
 * is showing the whole graph and a minimap would only repeat it smaller.
 */
export function viewportCoversGraph(projection: MinimapProjection): boolean {
  const r = projection.viewportRect
  return projection.dots.every((d) => d.x >= r.x && d.x <= r.x + r.width && d.y >= r.y && d.y <= r.y + r.height)
}
