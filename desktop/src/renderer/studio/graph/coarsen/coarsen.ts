/**
 * Coarsening: past a camera-ratio threshold, a community with at least
 * `MIN_COARSEN_MEMBERS` visible document members collapses into one
 * synthetic count node. This is a render-layer transform only — the
 * graphology model instance and the store's model are untouched, so
 * filters, search, and the inspector keep operating on the full model.
 *
 * Both constants are tuned together and are the only knobs. Deliberately
 * high: the design requires that coarsening does not visibly engage in
 * the low thousands.
 */

import type { GraphModel } from '../../../../shared/graph-model-types'

export const COARSEN_RATIO_THRESHOLD = 4
export const MIN_COARSEN_MEMBERS = 25

/**
 * The camera's entire contribution to coarsening: one bit, not a ratio.
 *
 * Render code keys its coarsening work on THIS, never on the raw ratio.
 * Applying a plan rebuilds the sigma graph twice over — restoring every
 * collapsed member, then dropping and rewriting them — so doing it per
 * camera frame is thousands of graphology mutations per wheel tick, each
 * invalidating Sigma's index. Zooming out past the threshold locked the app
 * hard enough to need a force quit. A bit changes twice per zoom.
 */
export function isCoarsened(cameraRatio: number): boolean {
  return cameraRatio >= COARSEN_RATIO_THRESHOLD
}

export interface CoarsenedCommunity {
  community: number
  memberIds: string[]
  centroid: { x: number; y: number }
}

export interface CoarsenPlan {
  collapsed: Map<number, CoarsenedCommunity>
}

const EMPTY_PLAN: CoarsenPlan = { collapsed: new Map() }

/**
 * Compute which communities should collapse given the current camera
 * ratio, the visible node set, and the set of communities the operator has
 * explicitly expanded (excluded from collapsing until re-collapsed or the
 * camera zooms back in).
 */
export function computeCoarsening(
  model: GraphModel,
  visible: Set<string>,
  cameraRatio: number,
  expandedCommunities: Set<number>,
  getPosition: (id: string) => { x: number; y: number } | undefined,
): CoarsenPlan {
  if (cameraRatio < COARSEN_RATIO_THRESHOLD) return EMPTY_PLAN

  const byCommunity = new Map<number, string[]>()
  for (const node of model.nodes) {
    if (node.kind !== 'document') continue
    if (!visible.has(node.id)) continue
    if (!byCommunity.has(node.community)) byCommunity.set(node.community, [])
    byCommunity.get(node.community)!.push(node.id)
  }

  const collapsed = new Map<number, CoarsenedCommunity>()
  for (const [community, memberIds] of byCommunity) {
    if (expandedCommunities.has(community)) continue
    if (memberIds.length < MIN_COARSEN_MEMBERS) continue

    let sumX = 0
    let sumY = 0
    let count = 0
    for (const id of memberIds) {
      const pos = getPosition(id)
      if (pos) {
        sumX += pos.x
        sumY += pos.y
        count++
      }
    }
    const centroid = count > 0 ? { x: sumX / count, y: sumY / count } : { x: 0, y: 0 }
    collapsed.set(community, { community, memberIds, centroid })
  }

  return { collapsed }
}

export function syntheticClusterNodeId(community: number): string {
  return `cluster:${community}`
}
