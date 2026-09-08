/**
 * Which nodes are labelled first. A stage of a few thousand documents
 * cannot name them all at once, and Sigma's label grid only knows a node's
 * drawn size — so a leaf and a hub the same size compete on equal terms,
 * and the hub loses half the time.
 *
 * A hub is a node whose degree sits at or above a percentile of the
 * corpus; it draws a heavier label. Which nodes are label CANDIDATES at all
 * is decided by degree rank and zoom (`labelEligibleCount`), because
 * Sigma's grid cannot thin below one label per cell and its cells are laid
 * out at zoom 1: zoomed out, a cell is a few screen pixels wide and every
 * candidate gets drawn, so the candidates themselves must be few. The top
 * few of those are landmarks, forced past the grid at any zoom.
 */

/** Degree percentile at or above which a node is a hub. */
export const HUB_DEGREE_PERCENTILE = 0.95
/** A corpus of leaves has no hubs: below this degree nothing is a hub, whatever the percentile says. */
export const MIN_HUB_DEGREE = 4
/** Hubs are a bounded set; past this share of the corpus a forced label is no longer a privilege. */
const MAX_HUB_SHARE = 0.03

export type LabelTier = 'hub' | 'normal'

/**
 * The degree at or above which a node is a hub, for a list of degrees.
 * Returns `Infinity` for an empty corpus so nothing qualifies.
 */
export function hubDegreeThreshold(degrees: number[]): number {
  if (degrees.length === 0) return Infinity
  const sorted = [...degrees].sort((a, b) => a - b)
  const percentileIndex = Math.min(sorted.length - 1, Math.floor(sorted.length * HUB_DEGREE_PERCENTILE))
  const shareIndex = Math.max(0, sorted.length - 1 - Math.floor(sorted.length * MAX_HUB_SHARE))
  const threshold = Math.max(sorted[percentileIndex], sorted[shareIndex], MIN_HUB_DEGREE)
  return threshold
}

export function labelTier(degree: number, threshold: number): LabelTier {
  return degree >= threshold ? 'hub' : 'normal'
}

/** Camera ratio past which the stage draws as an overview: points, hulls, landmarks only. */
export const LOD_RATIO_THRESHOLD = 2.5
/** The best-connected nodes, always labelled when they are candidates at all, past the grid budget. */
export const LANDMARK_COUNT = 12

/**
 * How many nodes, by degree rank, may carry a label at a camera ratio.
 *
 * At ratio 1 and closer every node is a candidate and the grid budget does
 * the thinning. Zooming out shrinks the grid's cells on screen while it
 * still admits one label per cell, so the candidate count falls with the
 * square of the ratio to keep the on-screen density level. Past the
 * overview threshold only landmarks remain, and their number falls the
 * same way, down to one.
 */
export function labelEligibleCount(nodeCount: number, ratio: number): number {
  if (nodeCount <= 0) return 0
  if (ratio <= 1) return nodeCount
  const thinned = Math.floor(nodeCount / (ratio * ratio))
  if (ratio <= LOD_RATIO_THRESHOLD) return Math.max(LANDMARK_COUNT, thinned)
  const landmarks = Math.floor(LANDMARK_COUNT * (LOD_RATIO_THRESHOLD / ratio) ** 2)
  return Math.max(1, Math.min(landmarks, thinned))
}

/**
 * The camera ratio in half-octave steps, so the reducer is rebuilt when the
 * label budget meaningfully changes and not on every frame of a zoom.
 */
export function quantizeLabelZoom(ratio: number): number {
  const safe = Math.max(1e-6, ratio)
  return 2 ** (Math.round(Math.log2(safe) * 2) / 2)
}

/** Degree rank per node id, best-connected first, ties broken by id so the order is stable. */
export function degreeRanks(nodes: { id: string; degree: number }[]): Map<string, number> {
  const sorted = [...nodes].sort((a, b) => (b.degree !== a.degree ? b.degree - a.degree : a.id < b.id ? -1 : 1))
  const ranks = new Map<string, number>()
  sorted.forEach((n, i) => ranks.set(n.id, i))
  return ranks
}
