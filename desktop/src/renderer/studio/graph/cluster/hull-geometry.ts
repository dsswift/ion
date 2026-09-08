/**
 * Pure geometry for the community hull layer: the convex hull itself, the
 * padded rounded outline drawn around it, and the rule that drops a hull
 * too sparse to mean anything.
 *
 * Kept free of canvas and sigma so every decision here is pinned by a
 * plain unit test.
 */

export interface Point {
  x: number
  y: number
}

/** Andrew's monotone chain convex hull. Returns the hull vertices in counter-clockwise order (y-up convention; on a y-down canvas the visual order is clockwise). */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points

  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y))
  const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

  const lower: Point[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }

  const upper: Point[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }

  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

/** Shoelace area of a simple polygon, always non-negative. */
export function polygonArea(polygon: Point[]): number {
  let twice = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    twice += a.x * b.y - b.x * a.y
  }
  return Math.abs(twice) / 2
}

/** One straight run of the padded outline, followed by an arc around the hull vertex it ends at. */
export interface PaddedSegment {
  from: Point
  to: Point
  /** The hull vertex the arc is centred on. */
  center: Point
  startAngle: number
  endAngle: number
}

/**
 * The outline of the hull offset outward by `padding`, with each corner
 * rounded by an arc of that radius centred on the original vertex: the
 * shape a rubber band stretched around discs of radius `padding` would
 * take. Rounded corners are what stop a three-member community from
 * drawing as a knife-edged shard.
 *
 * For each edge the outward normal is taken as the edge direction rotated
 * to the side away from the polygon's interior, decided from the polygon's
 * signed orientation so either vertex order works.
 */
export function paddedOutline(hull: Point[], padding: number): PaddedSegment[] {
  const n = hull.length
  if (n < 3) return []

  // Signed area > 0 means counter-clockwise in a y-up frame; the outward
  // normal of an edge is then the direction rotated clockwise (dy, -dx).
  let signed = 0
  for (let i = 0; i < n; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % n]
    signed += a.x * b.y - b.x * a.y
  }
  const outwardSign = signed > 0 ? 1 : -1

  const normals: Point[] = []
  for (let i = 0; i < n; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy) || 1
    normals.push({ x: (outwardSign * dy) / length, y: (-outwardSign * dx) / length })
  }

  const segments: PaddedSegment[] = []
  for (let i = 0; i < n; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % n]
    const normal = normals[i]
    const next = normals[(i + 1) % n]
    segments.push({
      from: { x: a.x + normal.x * padding, y: a.y + normal.y * padding },
      to: { x: b.x + normal.x * padding, y: b.y + normal.y * padding },
      center: b,
      startAngle: Math.atan2(normal.y, normal.x),
      endAngle: Math.atan2(next.y, next.x),
    })
  }
  return segments
}

export interface HullCandidate<T = unknown> {
  hull: Point[]
  memberCount: number
  tag: T
}

/** A hull whose area per member exceeds the median by this factor is a sparse community stretched across the stage, not a region. */
export const SPARSE_HULL_FACTOR = 6

/**
 * Drop hulls that would read as shards: a community of three members at
 * opposite corners of the stage encloses most of the picture while
 * describing nothing. The rule is relative — area per member against the
 * median hull — so a uniformly spread-out corpus keeps all its hulls, and
 * a lone outlier community is the one that goes.
 */
export function selectDrawableHulls<T>(candidates: HullCandidate<T>[]): HullCandidate<T>[] {
  const densities = candidates.map((c) => polygonArea(c.hull) / Math.max(1, c.memberCount))
  if (densities.length < 3) return candidates
  const sorted = [...densities].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (median <= 0) return candidates
  return candidates.filter((_, i) => densities[i] <= median * SPARSE_HULL_FACTOR)
}
