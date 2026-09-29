/**
 * Studio graph tool contracts shared by the main process, the preload bridge,
 * and the Studio renderer.
 *
 * The graph tools follow the browser tools' shape: main owns the tool
 * declarations and executes a call by sending ONE correlated command to the
 * Studio renderer, which owns the graph store, applies the command, and
 * acknowledges exactly once. Nothing about the graph (model, layout, camera)
 * ever crosses into main; main sees only the summary the renderer answers
 * with, which is also what the model reads.
 *
 * Every command carries the calling conversation and its working directory.
 * Neither comes from the model: the tool-gate responder supplies both, so a
 * call can never be retargeted at another conversation's project.
 */
import type { ChannelDimension, GraphFilterRule } from './graph-view-types'

const MAX_ID_LENGTH = 128
const MAX_PATH_LENGTH = 4096
const MAX_NODE_IDS = 500
const MAX_FILTER_RULES = 32
const MAX_FILTER_VALUES = 256

/** Where the camera goes after a highlight. `none` leaves the operator's view alone. */
export type GraphHighlightCamera = 'focus' | 'fit' | 'none'

/** Which scope a `scope` command sets. */
export type GraphScopeCommandMode = 'corpus' | 'neighborhood'

/** Which way a neighborhood scope's hops travel: along stored link direction, against it, or either. */
export type GraphScopeDirection = 'out' | 'in' | 'both'

/**
 * A correlated request from main to the Studio renderer.
 *
 * `open` is the only verb that changes what the operator is looking at: it
 * opens or reveals the Graph View tab for the conversation's directory. Every
 * other verb requires the graph to already be open for that directory and
 * refuses otherwise, so a background call cannot silently build a graph the
 * operator never asked for.
 */
export type StudioGraphCommand =
  | { kind: 'open'; conversationId: string; cwd: string }
  | { kind: 'state'; conversationId: string; cwd: string }
  | { kind: 'search'; conversationId: string; cwd: string; query: string; limit: number }
  | { kind: 'node'; conversationId: string; cwd: string; nodeId: string }
  | { kind: 'highlight'; conversationId: string; cwd: string; nodeIds: string[]; camera: GraphHighlightCamera }
  | { kind: 'clear-highlight'; conversationId: string; cwd: string }
  | { kind: 'fit'; conversationId: string; cwd: string }
  | { kind: 'filters'; conversationId: string; cwd: string; filters: GraphFilterRule[] }
  | { kind: 'scope'; conversationId: string; cwd: string; mode: GraphScopeCommandMode; anchorId?: string; depth?: number; direction?: GraphScopeDirection }
  | { kind: 'load-view'; conversationId: string; cwd: string; name: string }
  | { kind: 'peek'; conversationId: string; cwd: string; nodeId: string | null }

/** Envelope carrying one command plus its reply correlator. */
export interface StudioGraphCommandEnvelope {
  callId: string
  command: StudioGraphCommand
}

/** One node as the tools describe it. A subset of `GraphNode` the model can act on. */
export interface GraphToolNode {
  id: string
  label: string
  kind: string
  path: string | null
  degree: number
  community: number
  centrality: number
  orphan: boolean
  /** Whether filters and scope currently admit the node onto the stage. */
  visible: boolean
}

/** One edge touching a node, from that node's point of view. */
export interface GraphToolNeighbor {
  id: string
  label: string
  /** Which side of the edge the described node sits on. `both` for undirected edges. */
  direction: 'out' | 'in' | 'both'
  origin: string
  field?: string
}

/**
 * The graph as the tools summarise it after every command.
 *
 * Deliberately a summary: node ids the agent has asked about ride on the
 * command results, never a full node list, because a corpus can hold
 * thousands of documents and the model should search rather than page.
 */
export interface GraphToolState {
  projectPath: string
  nodeCount: number
  edgeCount: number
  visibleCount: number
  /** `idle` | `requested` | `running` | `settled`, as the render layer reports it. */
  layoutState: string
  selectedNodeIds: string[]
  highlightedNodeIds: string[]
  scope: { mode: GraphScopeCommandMode; anchorId: string | null; depth: number; direction: GraphScopeDirection }
  filters: GraphFilterRule[]
  /** Channel name to the dimension bound to it; unbound channels are omitted. */
  bindings: Record<string, ChannelDimension>
  /** Names of every saved view, project scope first. */
  savedViews: string[]
  /** Front-matter field names seen anywhere in the corpus, for filter authoring. */
  discoveredFields: string[]
  cameraRatio: number
}

/**
 * The renderer's single answer for one `callId`.
 *
 * `ok: false` with a populated `error` is a real refusal the model should
 * read (no Studio window, graph not open, unknown node). It is never a
 * silent empty success. `note` carries a soft caveat on a success, such as
 * a layout that was still running when the wait ran out.
 */
export interface StudioGraphCommandResult {
  callId: string
  ok: boolean
  error?: string
  note?: string
  state?: GraphToolState
  nodes?: GraphToolNode[]
  node?: GraphToolNode
  neighbors?: GraphToolNeighbor[]
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH
}

function idList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_NODE_IDS) return null
  const ids: string[] = []
  for (const entry of raw) {
    // A node id is a resolved identity or a path, so it takes the path bound.
    if (!isPath(entry)) return null
    ids.push(entry)
  }
  return ids
}

/**
 * Validate a channel dimension. The four shapes mirror `ChannelDimension`
 * exactly; anything else is rejected rather than coerced, because a filter
 * with an invented dimension would silently match nothing.
 */
export function parseChannelDimension(raw: unknown): ChannelDimension | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  switch (v.source) {
    case 'frontMatter':
      return isId(v.field) ? { source: 'frontMatter', field: v.field } : null
    case 'structural':
      return v.metric === 'degree' || v.metric === 'community' || v.metric === 'centrality' || v.metric === 'orphan'
        ? { source: 'structural', metric: v.metric }
        : null
    case 'mechanical':
      return v.property === 'path' || v.property === 'root' || v.property === 'sizeBytes' || v.property === 'modifiedMs'
        ? { source: 'mechanical', property: v.property }
        : null
    case 'edge':
      return v.metric === 'multiplicity' || v.metric === 'recency' || v.metric === 'rarity' || v.metric === 'overlap' || v.metric === 'crossRoot' || v.metric === 'origin' || v.metric === 'field'
        ? { source: 'edge', metric: v.metric }
        : null
    default:
      return null
  }
}

/** Validate one filter rule. Bounds are checked as numbers; `values` as a bounded string list. */
export function parseGraphFilterRule(raw: unknown): GraphFilterRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  const dimension = parseChannelDimension(v.dimension)
  if (!dimension) return null
  if (v.mode !== 'include' && v.mode !== 'exclude') return null
  const rule: GraphFilterRule = { dimension, mode: v.mode }
  if (v.values !== undefined) {
    if (!Array.isArray(v.values) || v.values.length > MAX_FILTER_VALUES || !v.values.every((x) => typeof x === 'string')) return null
    rule.values = v.values as string[]
  }
  if (v.match !== undefined) {
    if (v.match !== 'exact' && v.match !== 'prefix') return null
    rule.match = v.match
  }
  if (v.min !== undefined) {
    if (typeof v.min !== 'number' || !Number.isFinite(v.min)) return null
    rule.min = v.min
  }
  if (v.max !== undefined) {
    if (typeof v.max !== 'number' || !Number.isFinite(v.max)) return null
    rule.max = v.max
  }
  return rule
}

/** Validate a whole filter list. */
export function parseGraphFilterRules(raw: unknown): GraphFilterRule[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_FILTER_RULES) return null
  const rules: GraphFilterRule[] = []
  for (const entry of raw) {
    const rule = parseGraphFilterRule(entry)
    if (!rule) return null
    rules.push(rule)
  }
  return rules
}

/** Validate a command envelope crossing into the renderer. */
export function parseGraphCommandEnvelope(raw: unknown): StudioGraphCommandEnvelope | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (!isId(v.callId)) return null
  const command = parseGraphCommand(v.command)
  return command ? { callId: v.callId, command } : null
}

/**
 * Validate one command. Used by BOTH sides on purpose: main validates what
 * the tools build, the renderer validates what arrives over IPC, so the two
 * can never disagree about what a legal command is.
 */
export function parseGraphCommand(raw: unknown): StudioGraphCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const conversationId = v.conversationId
  const cwd = v.cwd
  if (!isId(conversationId) || !isPath(cwd)) return null
  const base = { conversationId, cwd }
  switch (v.kind) {
    case 'open':
    case 'state':
    case 'clear-highlight':
    case 'fit':
      return { kind: v.kind, ...base }
    case 'search': {
      if (typeof v.query !== 'string' || v.query.length === 0 || v.query.length > 512) return null
      const limit = typeof v.limit === 'number' && Number.isInteger(v.limit) && v.limit >= 1 && v.limit <= 100 ? v.limit : 20
      return { kind: 'search', ...base, query: v.query, limit }
    }
    case 'node':
      return isPath(v.nodeId) ? { kind: 'node', ...base, nodeId: v.nodeId } : null
    case 'highlight': {
      const nodeIds = idList(v.nodeIds)
      if (!nodeIds || nodeIds.length === 0) return null
      const camera = v.camera === 'focus' || v.camera === 'fit' || v.camera === 'none' ? v.camera : 'fit'
      return { kind: 'highlight', ...base, nodeIds, camera }
    }
    case 'filters': {
      const filters = parseGraphFilterRules(v.filters)
      return filters ? { kind: 'filters', ...base, filters } : null
    }
    case 'scope': {
      if (v.mode === 'corpus') return { kind: 'scope', ...base, mode: 'corpus' }
      if (v.mode !== 'neighborhood' || !isPath(v.anchorId)) return null
      const depth = v.depth === undefined ? undefined : (typeof v.depth === 'number' && Number.isInteger(v.depth) && v.depth >= 1 && v.depth <= 6 ? v.depth : null)
      if (depth === null) return null
      const direction = v.direction === undefined ? undefined : (v.direction === 'out' || v.direction === 'in' || v.direction === 'both' ? v.direction : null)
      if (direction === null) return null
      return { kind: 'scope', ...base, mode: 'neighborhood', anchorId: v.anchorId, ...(depth === undefined ? {} : { depth }), ...(direction === undefined ? {} : { direction }) }
    }
    case 'load-view':
      return isId(v.name) ? { kind: 'load-view', ...base, name: v.name } : null
    case 'peek':
      if (v.nodeId === null || v.nodeId === undefined) return { kind: 'peek', ...base, nodeId: null }
      return isPath(v.nodeId) ? { kind: 'peek', ...base, nodeId: v.nodeId } : null
    default:
      return null
  }
}

function parseToolNode(raw: unknown): GraphToolNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const n = raw as Record<string, unknown>
  if (!isPath(n.id)) return null
  return {
    id: n.id,
    label: typeof n.label === 'string' ? n.label : n.id,
    kind: typeof n.kind === 'string' ? n.kind : 'document',
    path: typeof n.path === 'string' ? n.path : null,
    degree: typeof n.degree === 'number' ? n.degree : 0,
    community: typeof n.community === 'number' ? n.community : -1,
    centrality: typeof n.centrality === 'number' ? n.centrality : 0,
    orphan: n.orphan === true,
    visible: n.visible !== false,
  }
}

function parseToolState(raw: unknown): GraphToolState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  if (typeof s.projectPath !== 'string') return null
  const scope = (s.scope && typeof s.scope === 'object' ? s.scope : {}) as Record<string, unknown>
  const bindings: Record<string, ChannelDimension> = {}
  if (s.bindings && typeof s.bindings === 'object' && !Array.isArray(s.bindings)) {
    for (const [channel, dim] of Object.entries(s.bindings as Record<string, unknown>)) {
      const parsed = parseChannelDimension(dim)
      if (parsed) bindings[channel] = parsed
    }
  }
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [])
  return {
    projectPath: s.projectPath,
    nodeCount: typeof s.nodeCount === 'number' ? s.nodeCount : 0,
    edgeCount: typeof s.edgeCount === 'number' ? s.edgeCount : 0,
    visibleCount: typeof s.visibleCount === 'number' ? s.visibleCount : 0,
    layoutState: typeof s.layoutState === 'string' ? s.layoutState : 'idle',
    selectedNodeIds: strings(s.selectedNodeIds),
    highlightedNodeIds: strings(s.highlightedNodeIds),
    scope: {
      mode: scope.mode === 'neighborhood' ? 'neighborhood' : 'corpus',
      anchorId: typeof scope.anchorId === 'string' ? scope.anchorId : null,
      depth: typeof scope.depth === 'number' ? scope.depth : 1,
      direction: scope.direction === 'out' || scope.direction === 'in' ? scope.direction : 'both',
    },
    filters: parseGraphFilterRules(s.filters) ?? [],
    bindings,
    savedViews: strings(s.savedViews),
    discoveredFields: strings(s.discoveredFields),
    cameraRatio: typeof s.cameraRatio === 'number' ? s.cameraRatio : 1,
  }
}

/** Validate the renderer's acknowledgement before main resolves its promise. */
export function parseGraphCommandResult(raw: unknown): StudioGraphCommandResult | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (!isId(v.callId) || typeof v.ok !== 'boolean') return null
  const result: StudioGraphCommandResult = { callId: v.callId, ok: v.ok }
  if (typeof v.error === 'string' && v.error) result.error = v.error.slice(0, 2048)
  if (typeof v.note === 'string' && v.note) result.note = v.note.slice(0, 2048)
  const state = parseToolState(v.state)
  if (state) result.state = state
  if (Array.isArray(v.nodes)) result.nodes = v.nodes.map(parseToolNode).filter((n): n is GraphToolNode => n !== null)
  const node = parseToolNode(v.node)
  if (node) result.node = node
  if (Array.isArray(v.neighbors)) {
    result.neighbors = v.neighbors.flatMap((entry): GraphToolNeighbor[] => {
      if (!entry || typeof entry !== 'object') return []
      const e = entry as Record<string, unknown>
      if (!isPath(e.id)) return []
      return [{
        id: e.id,
        label: typeof e.label === 'string' ? e.label : e.id,
        direction: e.direction === 'in' || e.direction === 'both' ? e.direction : 'out',
        origin: typeof e.origin === 'string' ? e.origin : 'wikilink',
        ...(typeof e.field === 'string' ? { field: e.field } : {}),
      }]
    })
  }
  return result
}
