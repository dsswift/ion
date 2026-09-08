/**
 * Saved views: pure capture and apply of a `GraphViewSavedView` against
 * the store's state and action set. Loading a view calls existing store
 * actions only — there is no second code path for applying a binding or a
 * filter, so a saved view is data, not behavior.
 */

import type {
  ChannelBindings,
  ClusterRendering,
  GraphFilterRule,
  GraphViewSavedView,
  LayoutForces,
  TagTreatment,
} from '../../../../shared/graph-view-types'

export interface SavedViewCaptureState {
  bindings: ChannelBindings
  filters: GraphFilterRule[]
  tagTreatment: TagTreatment
  clusterRendering: ClusterRendering
  showOrphans: boolean
  showDangling: boolean
  sectionNodes: boolean
  promotedFields: ReadonlySet<string>
  forces: LayoutForces
  positions: Map<string, { x: number; y: number }>
  pinnedNodeIds: ReadonlySet<string>
  /**
   * Whether a node id may be written into a durable artifact. A document
   * with no identity is keyed by its path for one read only, and a
   * section's identity is derived from its heading and ordinal at read
   * time; neither may be persisted, because the next read may key the same
   * document differently and a stored reference to the old key would then
   * dangle. Dangling stubs and coarsening clusters are derived the same way.
   */
  isDurableId(id: string): boolean
}

export interface CaptureResult {
  view: GraphViewSavedView
  /** Positions and pins withheld because their node id is provisional or derived. */
  droppedPositions: number
  droppedPins: number
}

/** Capture the current store state as a `GraphViewSavedView`. Camera is deliberately absent. */
export function captureView(state: SavedViewCaptureState, name: string): CaptureResult {
  const positions: Record<string, { x: number; y: number }> = {}
  let droppedPositions = 0
  for (const [id, pos] of state.positions) {
    if (state.isDurableId(id)) positions[id] = pos
    else droppedPositions++
  }
  const pinned: string[] = []
  let droppedPins = 0
  for (const id of state.pinnedNodeIds) {
    if (state.isDurableId(id)) pinned.push(id)
    else droppedPins++
  }
  return {
    view: {
      name,
      bindings: state.bindings,
      filters: state.filters,
      tagTreatment: state.tagTreatment,
      clusterRendering: state.clusterRendering,
      showOrphans: state.showOrphans,
      showDangling: state.showDangling,
      sectionNodes: state.sectionNodes,
      promotedFields: [...state.promotedFields],
      forces: state.forces,
      positions,
      pinned,
    },
    droppedPositions,
    droppedPins,
  }
}

export interface SavedViewApplyActions {
  setBinding(channel: keyof ChannelBindings, dimension: ChannelBindings[keyof ChannelBindings]['dimension']): void
  setFilters(filters: GraphFilterRule[]): void
  setTagTreatment(treatment: TagTreatment): void
  setClusterRendering(rendering: ClusterRendering): void
  setShowOrphans(show: boolean): void
  setShowDangling(show: boolean): void
  setSectionNodes(on: boolean): void
  setPromotedFields(fields: Iterable<string>): void
  setForces(forces: LayoutForces): void
  setNodePosition(id: string, x: number, y: number): void
  setPinnedNodes(ids: Iterable<string>): void
  hasNode(id: string): boolean
  /** The corpus's configured section-node default, for a view saved before the toggle existed. */
  configuredSectionNodes: boolean
  /** The built-in force defaults, for a view saved before forces were persisted. */
  defaultForces: LayoutForces
}

export interface ApplyViewResult {
  positionsApplied: number
  positionsMissing: number
  pinsApplied: number
  pinsMissing: number
}

/**
 * Apply a saved view's bindings, filters, treatments, layers, forces,
 * positions, and pins through existing store actions. A position or pin for
 * a node that no longer exists is counted as missing rather than applied;
 * camera and scope are untouched — a view loads into a fresh navigation
 * state.
 */
export function applyView(view: GraphViewSavedView, actions: SavedViewApplyActions): ApplyViewResult {
  for (const channel of Object.keys(view.bindings) as (keyof ChannelBindings)[]) {
    actions.setBinding(channel, view.bindings[channel].dimension)
  }
  actions.setFilters(view.filters)
  actions.setTagTreatment(view.tagTreatment)
  actions.setClusterRendering(view.clusterRendering)
  // A view saved before a toggle existed carries no field; every orphan and
  // every stub was on stage when it was saved, so that is what it restores.
  actions.setShowOrphans(view.showOrphans ?? true)
  actions.setShowDangling(view.showDangling ?? true)
  actions.setSectionNodes(view.sectionNodes ?? actions.configuredSectionNodes)
  actions.setPromotedFields(view.promotedFields ?? [])
  actions.setForces(view.forces ?? actions.defaultForces)

  let positionsApplied = 0
  let positionsMissing = 0
  for (const [id, pos] of Object.entries(view.positions)) {
    if (actions.hasNode(id)) {
      actions.setNodePosition(id, pos.x, pos.y)
      positionsApplied++
    } else {
      positionsMissing++
    }
  }

  // Pins for nodes that no longer exist are dropped rather than carried as
  // ghosts; a view saved before pins existed has none and clears the set.
  const pins = view.pinned ?? []
  const presentPins = pins.filter((id) => actions.hasNode(id))
  actions.setPinnedNodes(presentPins)

  return { positionsApplied, positionsMissing, pinsApplied: presentPins.length, pinsMissing: pins.length - presentPins.length }
}
