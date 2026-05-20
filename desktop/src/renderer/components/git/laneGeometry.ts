/**
 * Lane SVG path generators for the graph swimlanes.
 *
 * `SWIMLANE_CURVE_RADIUS` controls the corner rounding of fork/merge paths.
 * The shape is: vertical segment from the commit dot to near the row bottom,
 * a quadratic arc into a horizontal segment toward the parent lane. The
 * neighbouring row paints its own vertical incoming line, so the join is
 * clean.
 */

export const SWIMLANE_CURVE_RADIUS = 5

export function forkOrMergePath(x1: number, x2: number, cy: number, h: number, r = SWIMLANE_CURVE_RADIUS): string {
  if (Math.abs(x2 - x1) < 1) {
    return `M ${x1} ${cy} L ${x1} ${h}`
  }
  const sign = x2 > x1 ? 1 : -1
  return `M ${x1} ${cy} L ${x1} ${h - r} Q ${x1} ${h} ${x1 + sign * r} ${h} L ${x2} ${h}`
}
