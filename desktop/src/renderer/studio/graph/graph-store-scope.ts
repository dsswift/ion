/**
 * Scope, filter, and search slice: everything that decides WHICH nodes are
 * visible (filters, neighborhood scope, per-node hides, the orphan and
 * dangling toggles) or findable (search), plus the layer treatments that
 * change the model's node set (tags, sections, anchors) and the cluster
 * rendering. Encoding — HOW a visible node looks — stays in the store root.
 */

import { rDebug, rInfo } from '../../rendererLogger'
import { query as querySearchIndex } from './search/search-index'
import { rebuildAndSync, reprojectAfterVisibilityChange } from './graph-store-corpus'
import { MAX_SCOPE_DEPTH } from './filter/visibility'
import type { NeighborhoodDirection } from './scope/neighborhood'
import type { GraphFilterRule, TagTreatment, ClusterRendering } from '../../../shared/graph-view-types'
import type { GraphState, StoreGet, StoreSet } from './graph-store-types'

export function createScopeActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  GraphState,
  | 'setFilters'
  | 'setScopeToNeighborhood'
  | 'setScopeToCorpus'
  | 'expandScopeOneHop'
  | 'setScopeDepth'
  | 'setScopeDirection'
  | 'expandNodeScope'
  | 'collapseNodeScope'
  | 'drillInto'
  | 'setTagTreatment'
  | 'setClusterRendering'
  | 'setShowOrphans'
  | 'setShowDangling'
  | 'hideNode'
  | 'unhideAllNodes'
  | 'setSectionNodes'
  | 'setPromotedField'
  | 'setPromotedFields'
  | 'search'
  | 'jumpToSearchResult'
> {
  /** Every neighborhood change re-frames the camera on what is now visible and logs the new shape. */
  const refitNeighborhood = (extra: Record<string, unknown> = {}): void => {
    const { scope, visibleNodeIds } = get()
    reprojectAfterVisibilityChange(get, set)
    rInfo('graph_view', 'graph_view: scope changed', {
      mode: scope.mode,
      anchorId: scope.anchorId ?? 'null',
      depth: scope.depth,
      direction: scope.direction ?? 'both',
      expandedCount: scope.expandedIds?.size ?? 0,
      visibleCount: get().visibleNodeIds.size,
      ...extra,
    })
    void visibleNodeIds
    get().requestCamera({ kind: 'fit-nodes', nodeIds: [...get().visibleNodeIds] })
  }

  return {
    setFilters(filters: GraphFilterRule[]) {
      set({ filters })
      reprojectAfterVisibilityChange(get, set)
    },

    // Every scope change re-frames the camera on what is now visible: a
    // neighborhood fits its members, the whole corpus fits everything. The
    // render layer applies the request once the layout has settled, so a
    // request made at init still lands on laid-out positions.
    // A new anchor starts a fresh neighborhood: per-node expansions belonged
    // to the previous one. The direction carries over: it is a reading
    // preference, not a property of one anchor.
    setScopeToNeighborhood(anchorId: string, depth?: number) {
      const previous = get().scope
      const resolvedDepth = depth ?? previous.depth
      set({ scope: { mode: 'neighborhood', anchorId, depth: resolvedDepth, direction: previous.direction ?? 'both', expandedIds: new Set() } })
      refitNeighborhood()
    },

    setScopeToCorpus() {
      const previous = get().scope
      set({ scope: { mode: 'corpus', anchorId: null, depth: previous.depth, direction: previous.direction ?? 'both', expandedIds: new Set() } })
      reprojectAfterVisibilityChange(get, set)
      rInfo('graph_view', 'graph_view: scope changed', { mode: 'corpus', anchorId: 'null', depth: previous.depth, visibleCount: get().visibleNodeIds.size })
      get().requestCamera({ kind: 'fit-all' })
    },

    expandScopeOneHop() {
      const { scope } = get()
      if (scope.mode !== 'neighborhood') return
      get().setScopeDepth(scope.depth + 1)
    },

    setScopeDepth(depth: number) {
      const { scope } = get()
      if (scope.mode !== 'neighborhood') {
        rDebug('graph_view', 'graph_view: scope depth ignored', { depth, reason: 'corpus-scope' })
        return
      }
      const clamped = Math.max(1, Math.min(MAX_SCOPE_DEPTH, Math.round(depth)))
      if (clamped === scope.depth) return
      set({ scope: { ...scope, depth: clamped } })
      refitNeighborhood()
    },

    setScopeDirection(direction: NeighborhoodDirection) {
      const { scope } = get()
      if (scope.mode !== 'neighborhood') {
        // Remembered for the next neighborhood: the operator chose how they
        // want to read links, and that choice should not evaporate because
        // they happened to be in corpus scope when they made it.
        set({ scope: { ...scope, direction } })
        rDebug('graph_view', 'graph_view: scope direction stored', { direction, reason: 'corpus-scope' })
        return
      }
      if ((scope.direction ?? 'both') === direction) return
      set({ scope: { ...scope, direction } })
      refitNeighborhood()
    },

    // The gestural counterpart to the declarative depth: one double-click
    // pulls one node's neighbours in and they stay, so exploration grows the
    // picture outward from where the operator is looking rather than
    // widening every direction at once.
    expandNodeScope(id: string) {
      const { scope, graph } = get()
      if (scope.mode !== 'neighborhood') {
        rDebug('graph_view', 'graph_view: node expansion ignored', { nodeId: id, reason: 'corpus-scope' })
        return
      }
      if (!graph?.hasNode(id)) {
        rDebug('graph_view', 'graph_view: node expansion ignored', { nodeId: id, reason: 'not-in-graph' })
        return
      }
      const expandedIds = new Set(scope.expandedIds ?? [])
      if (expandedIds.has(id)) {
        rDebug('graph_view', 'graph_view: node expansion ignored', { nodeId: id, reason: 'already-expanded' })
        return
      }
      expandedIds.add(id)
      set({ scope: { ...scope, expandedIds } })
      refitNeighborhood()
    },

    // The inverse: visibility is recomputed from the anchor's BFS plus the
    // remaining expansions, so exactly what only this expansion added leaves
    // and everything another expansion or the anchor still reaches stays.
    collapseNodeScope(id: string) {
      const { scope } = get()
      if (scope.mode !== 'neighborhood' || !scope.expandedIds?.has(id)) {
        rDebug('graph_view', 'graph_view: node collapse ignored', { nodeId: id, reason: scope.mode !== 'neighborhood' ? 'corpus-scope' : 'not-expanded' })
        return
      }
      const expandedIds = new Set(scope.expandedIds)
      expandedIds.delete(id)
      set({ scope: { ...scope, expandedIds } })
      refitNeighborhood({ collapsedNodeId: id })
    },

    drillInto(id: string) {
      const { scope, graph, config } = get()
      if (!graph?.hasNode(id)) {
        rDebug('graph_view', 'graph_view: drill ignored', { nodeId: id, reason: 'not-in-graph' })
        return
      }
      if (scope.mode === 'corpus') {
        rInfo('graph_view', 'graph_view: drilled into node', { nodeId: id, from: 'corpus' })
        get().setScopeToNeighborhood(id, config?.neighborhoodDepth)
        return
      }
      rInfo('graph_view', 'graph_view: drilled into node', { nodeId: id, from: 'neighborhood' })
      get().expandNodeScope(id)
    },

    setTagTreatment(treatment: TagTreatment) {
      const changesGroupMembership = treatment !== get().tagTreatment
      set({ tagTreatment: treatment })
      rInfo('graph_view', 'graph_view: tag treatment changed', { treatment, tagField: get().config?.tagField ?? null })
      if (changesGroupMembership) rebuildAndSync(get, set, false)
    },

    setClusterRendering(rendering: ClusterRendering) {
      set({ clusterRendering: rendering })
      rInfo('graph_view', 'graph_view: cluster rendering changed', { rendering })
    },

    setShowOrphans(show: boolean) {
      if (show === get().showOrphans) return
      set({ showOrphans: show })
      rInfo('graph_view', 'graph_view: orphan visibility changed', { showOrphans: show })
      reprojectAfterVisibilityChange(get, set)
    },

    setShowDangling(show: boolean) {
      if (show === get().showDangling) return
      set({ showDangling: show })
      rInfo('graph_view', 'graph_view: dangling visibility changed', { showDangling: show, danglingCount: get().model?.dangling.length ?? 0 })
      reprojectAfterVisibilityChange(get, set)
    },

    hideNode(id: string) {
      if (!get().graph?.hasNode(id)) {
        rDebug('graph_view', 'graph_view: hide ignored', { nodeId: id, reason: 'not-in-graph' })
        return
      }
      const hiddenNodeIds = new Set(get().hiddenNodeIds)
      hiddenNodeIds.add(id)
      // A hidden node cannot stay selected: the inspector would describe
      // something that is not on stage.
      const selectedNodeIds = new Set(get().selectedNodeIds)
      selectedNodeIds.delete(id)
      set({ hiddenNodeIds })
      if (selectedNodeIds.size !== get().selectedNodeIds.size) get().selectNode(selectedNodeIds.size > 0 ? [...selectedNodeIds][0] : null)
      rInfo('graph_view', 'graph_view: node hidden', { nodeId: id, hiddenCount: hiddenNodeIds.size })
      reprojectAfterVisibilityChange(get, set)
    },

    unhideAllNodes() {
      const count = get().hiddenNodeIds.size
      if (count === 0) return
      set({ hiddenNodeIds: new Set() })
      rInfo('graph_view', 'graph_view: hidden nodes restored', { count })
      reprojectAfterVisibilityChange(get, set)
    },

    setSectionNodes(on: boolean) {
      if (on === get().sectionNodes) return
      set({ sectionNodes: on })
      rInfo('graph_view', 'graph_view: section nodes changed', { sectionNodes: on })
      rebuildAndSync(get, set, false)
    },

    setPromotedField(field: string, on: boolean) {
      const configured = get().config?.promotedFields.some((p) => p.field === field) ?? false
      if (!configured) {
        rDebug('graph_view', 'graph_view: promoted field ignored', { field, reason: 'not-configured' })
        return
      }
      const promotedFields = new Set(get().promotedFields)
      if (on === promotedFields.has(field)) return
      if (on) promotedFields.add(field)
      else promotedFields.delete(field)
      set({ promotedFields })
      rInfo('graph_view', 'graph_view: promoted field changed', { field, on, activeCount: promotedFields.size })
      rebuildAndSync(get, set, false)
    },

    setPromotedFields(fields: Iterable<string>) {
      const configured = new Set((get().config?.promotedFields ?? []).map((p) => p.field))
      const requested = [...fields]
      const promotedFields = new Set(requested.filter((f) => configured.has(f)))
      const before = get().promotedFields
      const same = before.size === promotedFields.size && [...before].every((f) => promotedFields.has(f))
      set({ promotedFields })
      rInfo('graph_view', 'graph_view: promoted fields replaced', { requested: requested.length, active: promotedFields.size, dropped: requested.length - promotedFields.size })
      if (!same) rebuildAndSync(get, set, false)
    },

    search(q: string) {
      const { searchIndex } = get()
      const results = querySearchIndex(searchIndex, q)
      rDebug('graph_view', 'graph_view: search executed', { queryLength: q.length, resultCount: results.length })
      return results
    },

    // Select, re-scope, then bring the hit into view. The focus request
    // supersedes the fit the scope change queued: a search result the
    // operator cannot see is a search that looks broken.
    jumpToSearchResult(id: string) {
      get().selectNode(id)
      get().setScopeToNeighborhood(id)
      get().requestCamera({ kind: 'focus', nodeId: id })
    },
  }
}
