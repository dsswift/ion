/**
 * Saved-view slice: capture, load, delete, and rename user-scoped views.
 * Every write goes through `graphViewSetUserConfig` with the FULL user view
 * list, because the settings file stores that list wholesale; project views
 * are never written from here.
 */

import { rInfo, rWarn } from '../../rendererLogger'
import { captureView, applyView } from './views/saved-views'
import { LAYOUT_FORCES_LOBES, type ScopedSavedView } from '../../../shared/graph-view-types'
import type { GraphState, StoreGet } from './graph-store-types'

export function createViewActions(get: StoreGet): Pick<GraphState, 'saveUserView' | 'loadView' | 'deleteUserView' | 'renameUserView'> {
  return {
    async saveUserView(name: string) {
      if (!name.trim()) return { ok: false, error: 'Name is required' }
      const state = get()
      const { view, droppedPositions, droppedPins } = captureView({ ...state, isDurableId: state.isDurableId }, name.trim())
      const config = state.config
      const existingUserViews = (config?.savedViews ?? []).filter((v) => v.source === 'user').map(({ source: _source, ...rest }) => rest)
      const nextUserViews = existingUserViews.some((v) => v.name === view.name)
        ? existingUserViews.map((v) => (v.name === view.name ? view : v))
        : [...existingUserViews, view]

      try {
        const result = await window.ion.graphViewSetUserConfig({ savedViews: nextUserViews })
        if (!result.ok) {
          rWarn('graph_view', 'graph_view: view save failed', { name: view.name, error: result.error ?? 'unknown' })
          return result
        }
        rInfo('graph_view', 'graph_view: view saved', {
          name: view.name,
          scope: 'user',
          bindingCount: Object.keys(view.bindings).length,
          filterCount: view.filters.length,
          positionCount: Object.keys(view.positions).length,
          pinCount: view.pinned?.length ?? 0,
          // Provisional and derived identities are never written to a durable
          // artifact; how many were withheld says how much of this view
          // depends on documents that are not yet stamped.
          droppedProvisionalPositions: droppedPositions,
          droppedProvisionalPins: droppedPins,
          sectionNodes: view.sectionNodes ?? false,
          promotedFieldCount: view.promotedFields?.length ?? 0,
        })
        return { ok: true }
      } catch (err) {
        rWarn('graph_view', 'graph_view: view save failed', { name: view.name, error: String(err) })
        return { ok: false, error: String(err) }
      }
    },

    loadView(view: ScopedSavedView) {
      const { graph } = get()
      const result = applyView(view, {
        setBinding: (channel, dimension) => get().setBinding(channel, dimension),
        setFilters: (filters) => get().setFilters(filters),
        setTagTreatment: (treatment) => get().setTagTreatment(treatment),
        setClusterRendering: (rendering) => get().setClusterRendering(rendering),
        setShowOrphans: (show) => get().setShowOrphans(show),
        setShowDangling: (show) => get().setShowDangling(show),
        setSectionNodes: (on) => get().setSectionNodes(on),
        setPromotedFields: (fields) => get().setPromotedFields(fields),
        setForces: (forces) => get().setForces(forces),
        setNodePosition: (id, x, y) => get().setNodePosition(id, x, y),
        setPinnedNodes: (ids) => get().setPinnedNodes(ids),
        hasNode: (id) => get().graph?.hasNode(id) ?? false,
        configuredSectionNodes: get().config?.sectionNodes ?? false,
        defaultForces: LAYOUT_FORCES_LOBES,
      })
      void graph
      // A view that carries no positions gets a fresh layout rather than
      // the arrangement left behind by whatever was on screen before it.
      // That arrangement was settled against a different filter set, a
      // different node set, and often different forces, so keeping it
      // shows the new view's data in the old view's shape — the nodes a
      // filter just revealed sit whereever they last happened to be, and
      // the ones it hid leave holes.
      //
      // A view that DOES carry positions is the opposite case: that layout
      // is the view, captured deliberately, so it is applied and left
      // alone.
      const relayout = result.positionsApplied === 0
      if (relayout) get().resetLayout()
      rInfo('graph_view', 'graph_view: view loaded', {
        name: view.name,
        source: view.source,
        positionsApplied: result.positionsApplied,
        positionsMissing: result.positionsMissing,
        pinsApplied: result.pinsApplied,
        pinsMissing: result.pinsMissing,
        relayout,
      })
    },

    async deleteUserView(name: string) {
      const config = get().config
      const remaining = (config?.savedViews ?? []).filter((v) => !(v.source === 'user' && v.name === name)).filter((v) => v.source === 'user').map(({ source: _source, ...rest }) => rest)
      try {
        const result = await window.ion.graphViewSetUserConfig({ savedViews: remaining })
        if (result.ok) rInfo('graph_view', 'graph_view: view deleted', { name })
        return result
      } catch (err) {
        rWarn('graph_view', 'graph_view: view delete failed', { name, error: String(err) })
        return { ok: false, error: String(err) }
      }
    },

    async renameUserView(oldName: string, newName: string) {
      const config = get().config
      const userViews = (config?.savedViews ?? []).filter((v) => v.source === 'user').map(({ source: _source, ...rest }) => rest)
      const renamed = userViews.map((v) => (v.name === oldName ? { ...v, name: newName } : v))
      try {
        const result = await window.ion.graphViewSetUserConfig({ savedViews: renamed })
        return result
      } catch (err) {
        rWarn('graph_view', 'graph_view: view rename failed', { oldName, newName, error: String(err) })
        return { ok: false, error: String(err) }
      }
    },
  }
}
