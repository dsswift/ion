/**
 * Graph View renderer store — shared contract C6.
 *
 * A window-local Zustand store outside `useSessionStore`, following the
 * `surface-store.ts` precedent. This is deliberate: the mirror-parity gate
 * (`mirror-parity.test.ts`) enumerates only `useSessionStore`'s
 * function-valued keys, so nothing here needs an entry in
 * `shared/studio-mirror-actions.ts`, and adding one would be wrong.
 *
 * The state shape and data defaults live in `graph-store-types.ts`; the
 * actions are composed from three slices plus the encoding and render-state
 * actions defined here:
 *
 *   - `graph-store-corpus.ts`  subscribe / delta / config / rebuild / dispose
 *   - `graph-store-scope.ts`   filters, scope, search, tag + cluster treatment
 *   - `graph-store-views.ts`   saved views
 *
 * A new action goes into whichever slice owns its concern; a new data field
 * goes into `GraphData` and `initialGraphData()` in the types module.
 */

import { create } from 'zustand'
import { rDebug, rInfo } from '../../rendererLogger'
import { detectValueType } from './channels/value-type'
import { isCoarsened } from './coarsen/coarsen'
import { computeEmphasis } from './selection/emphasis'
import { contentRouter } from '../../lib/file-open-router'
import { useSessionStore } from '../../stores/sessionStore'
import { createCorpusActions } from './graph-store-corpus'
import { createScopeActions } from './graph-store-scope'
import { createViewActions } from './graph-store-views'
import { durableIdPredicate } from './views/durable-ids'
import { initialGraphData, sampleValues, type ChannelName, type GraphState, type LayoutState } from './graph-store-types'
import type { ChannelDimension, ChannelValueType, LayoutForces } from '../../../shared/graph-view-types'
import type { CameraCommand } from './graph-camera'

export { defaultChannelBindings } from './graph-store-types'
export type { GraphState, LayoutState } from './graph-store-types'

let cameraRequestSeq = 0
let peekRequestSeq = 0

/** The union the reducers dim against: what the operator picked plus what an agent pointed at. */
function emphasisSeeds(selected: ReadonlySet<string>, highlighted: ReadonlySet<string>): Set<string> {
  return new Set([...selected, ...highlighted])
}

export const useGraphStore = create<GraphState>((set, get) => ({
  ...initialGraphData(),
  ...createCorpusActions(set, get),
  ...createScopeActions(set, get),
  ...createViewActions(get),

  // A click is the operator taking the stage back, so it also clears any
  // agent highlight: the two sets are drawn alike, and an agent's "look
  // here" that outlived the operator's own choice would read as a selection
  // they never made.
  selectNode(id: string | null) {
    const selectedNodeIds = new Set<string>(id ? [id] : [])
    const hadHighlight = get().agentHighlightNodeIds.size > 0
    set({ selectedNodeIds, agentHighlightNodeIds: new Set(), emphasisNodeIds: computeEmphasis(get().graph, selectedNodeIds) })
    rDebug('graph_view', 'graph_view: selection changed', { selectedCount: selectedNodeIds.size, emphasisCount: get().emphasisNodeIds.size, mode: 'replace', clearedAgentHighlight: hadHighlight })
  },

  setAgentHighlight(ids: Iterable<string>) {
    const graph = get().graph
    const requested = [...ids]
    const agentHighlightNodeIds = new Set(requested.filter((id) => graph?.hasNode(id)))
    set({ agentHighlightNodeIds, emphasisNodeIds: computeEmphasis(graph, emphasisSeeds(get().selectedNodeIds, agentHighlightNodeIds)) })
    rInfo('graph_view', 'graph_view: agent highlight set', {
      requested: requested.length,
      highlighted: agentHighlightNodeIds.size,
      dropped: requested.length - agentHighlightNodeIds.size,
      emphasisCount: get().emphasisNodeIds.size,
    })
  },

  clearAgentHighlight() {
    if (get().agentHighlightNodeIds.size === 0) return
    set({ agentHighlightNodeIds: new Set(), emphasisNodeIds: computeEmphasis(get().graph, get().selectedNodeIds) })
    rInfo('graph_view', 'graph_view: agent highlight cleared', { emphasisCount: get().emphasisNodeIds.size })
  },

  togglePin(id: string) {
    const pinnedNodeIds = new Set(get().pinnedNodeIds)
    const pinned = !pinnedNodeIds.has(id)
    if (pinned) pinnedNodeIds.add(id)
    else pinnedNodeIds.delete(id)
    // Written straight onto the graph so a layout that is running right now
    // respects it on its next tick; the sync re-derives it on every rebuild.
    const graph = get().graph
    if (graph?.hasNode(id)) graph.setNodeAttribute(id, 'fixed', pinned)
    set({ pinnedNodeIds })
    rInfo('graph_view', 'graph_view: node pin changed', { nodeId: id, pinned, pinnedCount: pinnedNodeIds.size })
  },

  setPinnedNodes(ids: Iterable<string>) {
    const pinnedNodeIds = new Set(ids)
    const graph = get().graph
    graph?.forEachNode((id) => graph.setNodeAttribute(id, 'fixed', pinnedNodeIds.has(id)))
    set({ pinnedNodeIds })
    rInfo('graph_view', 'graph_view: pinned set replaced', { pinnedCount: pinnedNodeIds.size })
  },

  toggleNodeSelection(id: string) {
    const selectedNodeIds = new Set(get().selectedNodeIds)
    if (selectedNodeIds.has(id)) selectedNodeIds.delete(id)
    else selectedNodeIds.add(id)
    const hadHighlight = get().agentHighlightNodeIds.size > 0
    set({ selectedNodeIds, agentHighlightNodeIds: new Set(), emphasisNodeIds: computeEmphasis(get().graph, selectedNodeIds) })
    rDebug('graph_view', 'graph_view: selection changed', { selectedCount: selectedNodeIds.size, emphasisCount: get().emphasisNodeIds.size, mode: 'toggle', clearedAgentHighlight: hadHighlight })
  },

  setNodePosition(id: string, x: number, y: number) {
    const positions = new Map(get().positions)
    positions.set(id, { x, y })
    // A NEW coordinate the graph does not have yet (a saved view's stored
    // layout), so the sync must run to carry it onto the graph.
    set({ positions, positionsEpoch: get().positionsEpoch + 1 })
  },

  /**
   * Persist coordinates HARVESTED FROM the graph: a drop, or a settled
   * layout run writing back where it landed.
   *
   * These deliberately do NOT advance `positionsEpoch`. The graph already
   * holds every one of these values, so re-syncing would write them back
   * onto the graph the layout worker is still simulating; the convergence
   * monitor measures movement by watching exactly those writes, so it would
   * read the sync as motion, reset its still-run counter, and keep running.
   * That is a closed loop: settle, write, sync, "movement", never settle.
   * Observed as nodes shaking after a drop, with no `layout cooled` line
   * ever logged for that run.
   */
  setNodePositions(entries: Map<string, { x: number; y: number }>) {
    if (entries.size === 0) return
    const positions = new Map(get().positions)
    for (const [id, pos] of entries) positions.set(id, pos)
    set({ positions })
    rDebug('graph_view', 'graph_view: node positions persisted', { movedNodes: entries.size })
  },

  setBinding(channel: ChannelName, dimension: ChannelDimension | null) {
    const { model, bindings } = get()
    const valueType: ChannelValueType = dimension && model ? detectValueType(sampleValues(channel, dimension, model)) : 'categorical'
    const nextBindings = { ...bindings, [channel]: { dimension, valueType } }
    set({ bindings: nextBindings })
    const sampled = dimension && model ? sampleValues(channel, dimension, model) : []
    const domainSize = new Set(sampled.filter((v) => v !== null && v !== undefined && v !== '').map(String)).size
    const unknownCount = sampled.filter((v) => v === null || v === undefined || v === '').length
    rInfo('graph_view', 'graph_view: channel bound', {
      channel,
      dimension: dimension ? JSON.stringify(dimension) : 'null',
      valueType,
      detected: valueType,
      overridden: false,
      domainSize,
      unknownCount,
    })
  },

  overrideValueType(channel: ChannelName, valueType: ChannelValueType) {
    const { bindings } = get()
    const current = bindings[channel]
    set({ bindings: { ...bindings, [channel]: { ...current, valueType } } })
    rInfo('graph_view', 'graph_view: channel bound', {
      channel,
      dimension: current.dimension ? JSON.stringify(current.dimension) : 'null',
      valueType,
      detected: valueType,
      overridden: true,
    })
  },

  resetLayout() {
    // A relayout from nothing, which is what makes this a way out of any
    // arrangement the operator no longer wants: every dragged position and
    // every pin is dropped, so the seed has nothing held to build around
    // and the run reproduces the settled picture the graph opened on.
    //
    // `layoutFree: null` is what makes it unconfined — a confined request
    // would skip seeding and only move a subset, which is the opposite of
    // a reset. The canvas seeds and starts the run when it sees
    // 'requested'.
    const graph = get().graph
    graph?.forEachNode((id) => graph.setNodeAttribute(id, 'fixed', false))
    const droppedPositions = get().positions.size
    const droppedPins = get().pinnedNodeIds.size
    set({
      positions: new Map(),
      pinnedNodeIds: new Set(),
      positionsEpoch: get().positionsEpoch + 1,
      layoutFree: null,
      layoutState: 'requested',
    })
    rInfo('graph_view', 'graph_view: layout reset', { droppedPositions, droppedPins, nodeCount: graph?.order ?? 0 })
  },

  setLayoutState(state: LayoutState) {
    // A confinement belongs to the request it came with; once the render
    // layer has taken the request up, it is consumed.
    set(state === 'requested' ? { layoutState: state } : { layoutState: state, layoutFree: null })
  },

  setQuickPeek(id: string | null, at?: { x: number; y: number } | null) {
    set({ quickPeekNodeId: id, quickPeekAt: id ? at ?? null : null, ...(id ? { quickPeekEdgeId: null } : {}) })
  },

  setQuickPeekEdge(edgeId: string | null) {
    if (edgeId === get().quickPeekEdgeId) return
    set({ quickPeekEdgeId: edgeId, ...(edgeId ? { quickPeekNodeId: null } : {}) })
  },

  // Hover emphasis is immediate and transient: it never moves the camera,
  // never opens the inspector, and is gone when the pointer leaves. The
  // reducers dim against the union of this set and the selection's.
  setHoverNode(id: string | null) {
    if (id === get().hoverNodeId) return
    const graph = get().graph
    const seeds = new Set<string>(id && graph?.hasNode(id) ? [id] : [])
    set({ hoverNodeId: seeds.size > 0 ? id : null, hoverEmphasisNodeIds: computeEmphasis(graph, seeds) })
    rDebug('graph_view', 'graph_view: hover changed', { nodeId: id ?? 'null', emphasisCount: get().hoverEmphasisNodeIds.size })
  },

  openContextMenu(nodeId: string | null, at: { x: number; y: number }) {
    set({ contextMenu: { nodeId, at } })
    rDebug('graph_view', 'graph_view: context menu opened', { nodeId: nodeId ?? 'stage' })
  },

  closeContextMenu() {
    if (!get().contextMenu) return
    set({ contextMenu: null })
    rDebug('graph_view', 'graph_view: context menu closed', {})
  },

  setForces(forces: LayoutForces) {
    const current = get().forces
    const same =
      current.gravity === forces.gravity &&
      current.scalingRatio === forces.scalingRatio &&
      current.edgeWeightInfluence === forces.edgeWeightInfluence &&
      current.damping === forces.damping
    if (same) return
    set({ forces: { ...forces } })
    rInfo('graph_view', 'graph_view: forces changed', { ...forces })
  },

  requestOpenFile(id: string) {
    const { model } = get()
    const node = model?.nodes.find((n) => n.id === id)
    if (!node || !node.path) {
      rDebug('graph_view', 'graph_view: open file requested', { nodeId: id, reason: 'node-has-no-file' })
      return
    }
    const router = contentRouter()
    const projectPath = get().projectPath
    // The tab whose Studio surface panel actually renders this graph — NOT
    // the corpus root. `openTextFile`'s second argument is a conversation
    // id: the surface store resolves it against `useSessionStore`'s live
    // tabs to find whose file buffer and tab list to update. Passing the
    // corpus root there looked plausible (it is a real path) but matched no
    // tab, so `materializeFileBuffer` logged "source tab gone" and bailed —
    // the button did nothing, silently.
    const tabId = useSessionStore.getState().activeTabId
    if (router && projectPath && tabId) {
      router.openTextFile(projectPath, tabId, node.path)
      rInfo('graph_view', 'graph_view: open file requested', { nodeId: id, path: node.path, tabId })
    } else {
      rDebug('graph_view', 'graph_view: open file requested', { nodeId: id, reason: 'no-active-tab' })
    }
  },

  setCameraRatio(ratio: number) {
    const { cameraRatio } = get()
    const wasEngaged = isCoarsened(cameraRatio)
    const nowEngaged = isCoarsened(ratio)
    set({ cameraRatio: ratio })
    if (wasEngaged !== nowEngaged) {
      if (nowEngaged) {
        rDebug('graph_view', 'graph_view: coarsening engaged', { cameraRatio: ratio })
      } else {
        rDebug('graph_view', 'graph_view: coarsening released', { cameraRatio: ratio })
        set({ expandedCommunities: new Set() })
      }
    }
  },

  requestCamera(command: CameraCommand) {
    cameraRequestSeq++
    set({ cameraRequest: { ...command, seq: cameraRequestSeq } })
    rDebug('graph_view', 'graph_view: camera requested', { kind: command.kind, seq: cameraRequestSeq })
    return cameraRequestSeq
  },

  noteCameraApplied(seq: number) {
    // Monotonic: a slow animation finishing after a newer one has already
    // been reported must not roll the marker back.
    if (seq <= get().cameraAppliedSeq) return
    set({ cameraAppliedSeq: seq })
    rDebug('graph_view', 'graph_view: camera applied', { seq })
  },

  requestPeek(nodeId: string) {
    peekRequestSeq++
    set({ peekRequest: { nodeId, seq: peekRequestSeq } })
    rDebug('graph_view', 'graph_view: peek requested', { nodeId, seq: peekRequestSeq })
    return peekRequestSeq
  },

  expandCommunity(community: number) {
    const expanded = new Set(get().expandedCommunities)
    expanded.add(community)
    set({ expandedCommunities: expanded })
    rDebug('graph_view', 'graph_view: community expanded', { community })
  },

  collapseCommunity(community: number) {
    if (!get().expandedCommunities.has(community)) return
    const expanded = new Set(get().expandedCommunities)
    expanded.delete(community)
    set({ expandedCommunities: expanded })
    rDebug('graph_view', 'graph_view: community collapsed', { community, expandedCount: expanded.size })
  },

  collapseAllCommunities() {
    const count = get().expandedCommunities.size
    if (count === 0) return
    set({ expandedCommunities: new Set() })
    rDebug('graph_view', 'graph_view: all communities collapsed', { count })
  },

  isDurableId(id: string) {
    return durableIdPredicate(get().model)(id)
  },
}))
