/**
 * Graph View store contract: the `GraphState` shape, its data defaults, and
 * the small helpers every action slice shares. Slices (`graph-store-corpus`,
 * `graph-store-scope`, `graph-store-views`) import from here so they never
 * import the composed store itself — that keeps the module graph acyclic and
 * lets each slice be typed against the full state without owning it.
 */

import type Graph from 'graphology'
import { nodeValue, edgeValue } from './channels/dimension-values'
import type { GraphScope } from './filter/visibility'
import type { NeighborhoodDirection } from './scope/neighborhood'
import type { SearchEntry } from './search/search-index'
import type { CameraCommand, CameraRequest } from './graph-camera'
import {
  LAYOUT_FORCES_LOBES,
  type GraphViewConfig,
  type ChannelBindings,
  type ChannelDimension,
  type ChannelValueType,
  type GraphFilterRule,
  type LayoutForces,
  type TagTreatment,
  type ClusterRendering,
  type ScopedSavedView,
} from '../../../shared/graph-view-types'
import type { CorpusDelta, CorpusSnapshot, CorpusWatchState } from '../../../shared/graph-corpus-types'
import type { GraphModel, GraphNode, GraphEdge } from '../../../shared/graph-model-types'
import type { SectionScopeNotice } from './graph-store-corpus'

/**
 * `requested` is the store asking for a fresh simulation. The store cannot
 * start one itself: seeding and scale normalization are both defined in
 * viewport pixels, and only the render layer knows the viewport — so
 * `GraphCanvas` owns the simulation's lifecycle and reports back through
 * `setLayoutState`.
 */
export type LayoutState = 'idle' | 'requested' | 'running' | 'settled'

const UNBOUND_BINDING = { dimension: null, valueType: 'categorical' as ChannelValueType }

export function defaultChannelBindings(): ChannelBindings {
  return {
    nodeColor: { ...UNBOUND_BINDING },
    nodeShape: { ...UNBOUND_BINDING },
    nodeSize: { ...UNBOUND_BINDING },
    edgeColor: { ...UNBOUND_BINDING },
    edgeThickness: { ...UNBOUND_BINDING },
    edgeOpacity: { ...UNBOUND_BINDING },
  }
}

export type ChannelName = keyof ChannelBindings
const NODE_CHANNELS: ChannelName[] = ['nodeColor', 'nodeShape', 'nodeSize']

/** Sample every value a dimension would read across the model's nodes or edges. */
export function sampleValues(channel: ChannelName, dimension: ChannelDimension, model: GraphModel): unknown[] {
  if (NODE_CHANNELS.includes(channel)) {
    return model.nodes.map((n: GraphNode) => nodeValue(n, dimension))
  }
  return model.edges.map((e: GraphEdge) => edgeValue(e, model, dimension))
}

/** The data half of the store — everything that is not a function. */
export interface GraphData {
  projectPath: string | null
  config: GraphViewConfig | null
  snapshot: CorpusSnapshot | null
  model: GraphModel | null
  graph: Graph | null
  /** The selection. Plain click replaces it; Shift+click toggles membership. */
  selectedNodeIds: Set<string>
  /**
   * Nodes an agent asked the operator to look at. Drawn exactly like the
   * selection and folded into `emphasisNodeIds`, but kept apart from
   * `selectedNodeIds` so an agent's "look here" never overwrites what the
   * operator picked. Cleared by the operator's next click on the stage.
   */
  agentHighlightNodeIds: Set<string>
  /** Selected and agent-highlighted nodes plus their 1-hop neighbours; everything else draws dimmed while either set is non-empty. Derived, never set directly. */
  emphasisNodeIds: Set<string>
  /**
   * The node under the pointer, from the moment it is entered. Hover is the
   * primary reading gesture: its 1-hop neighbourhood stays lit and the rest
   * fades, with no camera move and no inspector. Quick Peek still waits its
   * delay; this does not.
   */
  hoverNodeId: string | null
  /** The hovered node plus its 1-hop neighbours. Derived from `hoverNodeId`, never set directly. */
  hoverEmphasisNodeIds: Set<string>
  /** Nodes held in place: the layout does not move them and a drag does not pull them along. Travel with a saved view. */
  pinnedNodeIds: Set<string>
  positions: Map<string, { x: number; y: number }>
  /**
   * Set when section nodes are on but the scope is too wide to decompose,
   * so the chrome can say so. Null whenever sections are off or generated.
   */
  sectionScopeNotice: SectionScopeNotice | null
  /**
   * Bumped only when `positions` gains a coordinate the sigma graph does
   * NOT already have (a saved view's stored layout). The canvas sync keys
   * on this rather than on the map itself, so a settled-layout or drop
   * write-back does not re-enter the sync that feeds the running
   * simulation.
   */
  positionsEpoch: number
  layoutState: LayoutState
  watchState: CorpusWatchState | null
  available: boolean
  error: string | null
  bindings: ChannelBindings
  filters: GraphFilterRule[]
  scope: GraphScope
  visibleNodeIds: Set<string>
  tagTreatment: TagTreatment
  clusterRendering: ClusterRendering
  /** Orphan documents on stage or hidden. Part of visibility, so a change recomputes `visibleNodeIds`. */
  showOrphans: boolean
  /** Dangling (broken-link) stubs drawn or withheld. The badge reports them either way. */
  showDangling: boolean
  /** Nodes the operator hid one at a time. A visibility fact, so a rule edit never reveals them by accident. */
  hiddenNodeIds: Set<string>
  /**
   * Whether documents decompose into section nodes. Seeded from the corpus's
   * `sectionNodes` config on init and toggled at view time; a change rebuilds
   * the model and settles the new nodes in place.
   */
  sectionNodes: boolean
  /** Which configured `promotedFields` are drawn as anchor nodes. Off until the operator turns one on. */
  promotedFields: Set<string>
  /** The force-layout parameters in force. Travel with a saved view. */
  forces: LayoutForces
  /**
   * With `layoutState: 'requested'`, the nodes the render layer should let
   * move, or null for a whole-graph layout. A structural toggle (tag nodes,
   * anchors, sections) places its new nodes beside their neighbours and asks
   * for a run confined to them plus what they touch, so the picture the
   * operator arranged is not re-laid out around a few additions.
   */
  layoutFree: Set<string> | null
  /** The open context menu: the node it was opened on (null for the stage) and where, in graph-container coordinates. */
  contextMenu: { nodeId: string | null; at: { x: number; y: number } } | null
  /** The hovered edge, when edge events are on. Quick Peek describes it. */
  quickPeekEdgeId: string | null
  searchIndex: SearchEntry[]
  quickPeekNodeId: string | null
  /** Where to draw the hover card, in graph-container coordinates. Null until a hover resolves one. */
  quickPeekAt: { x: number; y: number } | null
  expandedCommunities: Set<number>
  cameraRatio: number
  /**
   * The pending camera command. The store cannot move the camera — only the
   * render layer holds sigma — so it records the request and `GraphCanvas`
   * consumes it by `seq`, deferring while a layout is still running.
   */
  cameraRequest: CameraRequest | null
  /**
   * The `seq` of the last camera request the render layer finished
   * applying, animation included. A caller that must know the picture has
   * landed (an agent tool acknowledging a move) waits for this to reach the
   * seq it requested; the request alone only says the move was asked for.
   */
  cameraAppliedSeq: number
  /**
   * A pending Quick Peek by node rather than by pointer. Only the render
   * layer can turn a node into stage coordinates, so the store records the
   * ask and `GraphCanvas` consumes it by `seq`, exactly like the camera.
   */
  peekRequest: { nodeId: string; seq: number } | null
}

/**
 * A fresh data state. Used both to seed the store and by `dispose()` to
 * return it to exactly that state, so the two can never drift apart.
 */
export function initialGraphData(): GraphData {
  return {
    projectPath: null,
    config: null,
    snapshot: null,
    model: null,
    graph: null,
    selectedNodeIds: new Set(),
    agentHighlightNodeIds: new Set(),
    emphasisNodeIds: new Set(),
    hoverNodeId: null,
    hoverEmphasisNodeIds: new Set(),
    pinnedNodeIds: new Set(),
    positions: new Map(),
    sectionScopeNotice: null,
    positionsEpoch: 0,
    layoutState: 'idle',
    watchState: null,
    available: false,
    error: null,
    bindings: defaultChannelBindings(),
    filters: [],
    scope: { mode: 'corpus', anchorId: null, depth: 1 },
    visibleNodeIds: new Set(),
    // 'filter' rather than 'off': tags are filterable and bindable without
    // adding a node per tag value, which is the useful default for a corpus
    // whose tag count dwarfs its document count. 'off' withholds the field
    // entirely and is a deliberate choice, not a starting point.
    tagTreatment: 'filter',
    clusterRendering: 'hull',
    showOrphans: true,
    showDangling: true,
    hiddenNodeIds: new Set(),
    sectionNodes: false,
    promotedFields: new Set(),
    forces: { ...LAYOUT_FORCES_LOBES },
    layoutFree: null,
    contextMenu: null,
    quickPeekEdgeId: null,
    searchIndex: [],
    quickPeekNodeId: null,
    quickPeekAt: null,
    expandedCommunities: new Set(),
    cameraRatio: 1,
    cameraRequest: null,
    cameraAppliedSeq: 0,
    peekRequest: null,
  }
}

export interface GraphState extends GraphData {
  init(projectPath: string): Promise<void>
  /** Resolve availability only, for the "+" menu predicate — no corpus subscribe. */
  checkAvailability(projectPath: string): Promise<void>
  applyDelta(delta: CorpusDelta): void
  applyConfig(config: GraphViewConfig): void
  /** Replace the selection with one node, or clear it with null. */
  selectNode(id: string | null): void
  /** Add or remove one node from the selection without touching the rest. */
  toggleNodeSelection(id: string): void
  /** Replace the agent highlight. Ids the graph does not hold are dropped, so the set only ever names real nodes. */
  setAgentHighlight(ids: Iterable<string>): void
  clearAgentHighlight(): void
  /** Hold a node in place, or release it. */
  togglePin(id: string): void
  /** Replace the pinned set wholesale (a saved view loading). */
  setPinnedNodes(ids: Iterable<string>): void
  /**
   * Discard every dragged position and pin and lay the graph out again from
   * a fresh seed — the way back from an arrangement the operator has
   * pushed out of shape.
   */
  resetLayout(): void
  setNodePosition(id: string, x: number, y: number): void
  /** Persist a whole drag's worth of moved nodes in one write. */
  setNodePositions(entries: Map<string, { x: number; y: number }>): void
  /** Bind a channel to a dimension, auto-detecting its value type from the current model. */
  setBinding(channel: ChannelName, dimension: ChannelDimension | null): void
  /** Manually override a channel's value type, replacing the auto-detected one. */
  overrideValueType(channel: ChannelName, valueType: ChannelValueType): void
  setFilters(filters: GraphFilterRule[]): void
  setScopeToNeighborhood(anchorId: string, depth?: number): void
  setScopeToCorpus(): void
  expandScopeOneHop(): void
  /** Set the neighborhood depth directly, in either direction. Clamped to 1..MAX_SCOPE_DEPTH. No-op in corpus scope. */
  setScopeDepth(depth: number): void
  /** Which way the neighborhood BFS travels. No-op in corpus scope. */
  setScopeDirection(direction: NeighborhoodDirection): void
  /** Pull one node's neighbours into a neighborhood scope. No-op in corpus scope. */
  expandNodeScope(id: string): void
  /** Undo one `expandNodeScope`: what only that expansion added leaves the picture. No-op when the node was not expanded. */
  collapseNodeScope(id: string): void
  /** Double-click: from corpus scope, enter the node's neighborhood; from inside one, expand that node. */
  drillInto(id: string): void
  /** Tag treatment; the field itself comes from `config.tagField`. */
  setTagTreatment(treatment: TagTreatment): void
  setClusterRendering(rendering: ClusterRendering): void
  setShowOrphans(show: boolean): void
  setShowDangling(show: boolean): void
  /** Withhold one node from the stage until `unhideAllNodes`. */
  hideNode(id: string): void
  unhideAllNodes(): void
  /** Section decomposition at view time. Rebuilds the model. */
  setSectionNodes(on: boolean): void
  /** Turn one configured promoted field's anchors on or off. Rebuilds the model. */
  setPromotedField(field: string, on: boolean): void
  /** Replace the active promoted-field set (a saved view loading). */
  setPromotedFields(fields: Iterable<string>): void
  /** Replace the force parameters. The render layer re-runs the simulation to show the new shape. */
  setForces(forces: LayoutForces): void
  /** The node under the pointer, or null when it leaves. */
  setHoverNode(id: string | null): void
  openContextMenu(nodeId: string | null, at: { x: number; y: number }): void
  closeContextMenu(): void
  setQuickPeekEdge(edgeId: string | null): void
  search(q: string): SearchEntry[]
  jumpToSearchResult(id: string): void
  /** `at` is the hovered node's position in graph-container coordinates. */
  setQuickPeek(id: string | null, at?: { x: number; y: number } | null): void
  /** Cmd/Ctrl+click: open the underlying file through the router. No-op + DEBUG for a fileless node. */
  requestOpenFile(id: string): void
  /** Save the current state as a named user view (writes through GRAPH_VIEW_SET_USER_CONFIG). */
  saveUserView(name: string): Promise<{ ok: boolean; error?: string }>
  /** Load any view (project or user scope) by reference. */
  loadView(view: ScopedSavedView): void
  deleteUserView(name: string): Promise<{ ok: boolean; error?: string }>
  renameUserView(oldName: string, newName: string): Promise<{ ok: boolean; error?: string }>
  setCameraRatio(ratio: number): void
  /** Ask the render layer to move the camera. Each call is a distinct request even when identical to the last. Returns the request's seq. */
  requestCamera(command: CameraCommand): number
  /** Reported by the render layer once a camera request has finished moving. */
  noteCameraApplied(seq: number): void
  /** Ask the render layer to open Quick Peek on a node. Returns the request's seq. */
  requestPeek(nodeId: string): number
  /** Reported by the render layer, which owns the simulation's lifecycle. */
  setLayoutState(state: LayoutState): void
  expandCommunity(community: number): void
  /** Re-collapse one community the operator opened while coarsened. */
  collapseCommunity(community: number): void
  collapseAllCommunities(): void
  /** Whether a node id may be written into a saved view. Derived from the model; see `views/durable-ids.ts`. */
  isDurableId(id: string): boolean
  /** Park the live session for later resume and clear the store. Called when the surface stops tracking this directory. */
  dispose(): void
  /** Release a directory's session for good: drops parked state and hands back the corpus reference. Called when the graph tab is closed. */
  closeSession(projectPath: string): void
}

/** The Zustand `set`/`get` pair every action slice is built from. */
export type StoreSet = (partial: Partial<GraphState>) => void
export type StoreGet = () => GraphState
