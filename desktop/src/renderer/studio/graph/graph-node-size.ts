/**
 * Node render size — one function, used by three callers that must agree:
 * the node reducer (what Sigma draws when the size channel is unbound), the
 * model→graphology sync (the `size` attribute Sigma falls back to and the
 * overlap resolver reads), and the overlap resolver itself (the radius it
 * keeps clear).
 *
 * Sizes are SCREEN PIXELS AT CAMERA RATIO 1, not graph units — Sigma's
 * `itemSizesReference` is `"screen"`, and the drawn radius is this size
 * divided by `zoomToSizeRatioFunction(ratio)`, which is the square root of
 * the ratio (pinned in `graph-sigma-settings.ts`): zooming in by four
 * doubles a node on screen, so nodes grow like features on a map rather
 * than staying dots among widening edges. Anything reasoning about node
 * collision in graph space has to convert (see `graph-overlap.ts`).
 */

/**
 * Node radii are deliberately small. A force layout separates nodes by
 * repulsion, but a no-overlap guarantee is an area constraint: once the
 * corpus's total node area approaches the viewport's, the only arrangement
 * with no overlaps is a dense hexagonal packing, and the whole graph reads
 * as one filled disc no matter what structure the layout found. Keeping a
 * few thousand nodes to a small fraction of the stage's area is what leaves
 * room for communities, branches and peninsulas to be visible.
 */
const MIN_BASE_SIZE = 2.5
const MAX_DEGREE_BONUS = 6
const DEGREE_SCALE = 1

const CLUSTER_MIN_SIZE = 7
const CLUSTER_MAX_BONUS = 9
const CLUSTER_SCALE = 1.6

/** Degree-driven radius for an ordinary node, before the kind multiplier. */
export function degreeSize(degree: number): number {
  return MIN_BASE_SIZE + Math.min(MAX_DEGREE_BONUS, Math.sqrt(Math.max(0, degree)) * DEGREE_SCALE)
}

/** Structural kinds draw at their own scale: dangling and section read as secondary, an anchor as a place. */
export function kindSizeMultiplier(kind: string): number {
  if (kind === 'dangling') return 0.7
  if (kind === 'section') return 0.6
  if (kind === 'anchor') return 1.3
  return 1
}

/**
 * The radius Sigma should draw for a node, in screen pixels.
 *
 * A synthetic cluster node (coarsening) has no degree of its own — it stands
 * in for `memberCount` documents, so it sizes off that instead. Sizing it by
 * its zero degree drew a collapsed community of two hundred documents as the
 * smallest dot on the stage.
 */
export function nodeRenderSize(kind: string, degree: number, memberCount = 0): number {
  if (kind === 'cluster') {
    return CLUSTER_MIN_SIZE + Math.min(CLUSTER_MAX_BONUS, Math.sqrt(Math.max(0, memberCount)) * CLUSTER_SCALE)
  }
  return degreeSize(degree) * kindSizeMultiplier(kind)
}
