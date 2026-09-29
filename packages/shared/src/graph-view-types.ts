/**
 * Graph View shared contract (C1).
 *
 * Types, defaults, and the project-scope allowlist for Graph View
 * configuration. Frozen by the program manifest
 * (`.workbench/gh-397-metadata-driven-graph-view/spec.md`); every later
 * child imports from here rather than redefining a shape.
 *
 * `GraphViewConfig.corpusRoots` empty means Graph View is unavailable. That
 * is the single availability predicate in the program; no child invents
 * another.
 */

/** One configured corpus root. `path` may contain a leading `~`. */
export interface CorpusRootConfig {
  path: string
  label?: string
}

/** Operator curation of a discovered front-matter field. Additive polish only. */
export interface GraphViewCuratedField {
  field: string
  displayName?: string
  order?: number
  hidden?: boolean
}

/**
 * A note-descriptive property the operator may promote to virtual anchor
 * nodes at view time. Promotion is off until the operator turns it on for a
 * view, and a promoted property keeps its filter role either way.
 *
 * `field` is a front-matter field name, or `path` for the document's
 * location relative to its corpus root. Because a promotable property is
 * often hierarchical (a path, an ownership scope), `depth` chooses the level
 * a value is anchored at: `1` keeps the first `/`-separated segment, `2` the
 * first two, and absent or `0` keeps the whole value. A value that is one
 * segment of a larger delimited string (an ORN's scope) is reached with
 * `split`: the raw value is divided on `separator` and segment `index`
 * (zero-based) is the value the depth cut then applies to.
 */
export interface GraphPromotedField {
  field: string
  depth?: number
  split?: { separator: string; index: number }
}

/**
 * The force-layout parameters an operator can change at view time. Each is a
 * ForceAtlas2 knob: `gravity` pulls everything toward the centre (the round,
 * compact shape), `scalingRatio` is the repulsion scale (spread), `edgeWeightInfluence`
 * is how strongly links pull, and `damping` multiplies the simulation's
 * slow-down. Persisted with a saved view so a corpus can ship its preferred
 * shape.
 */
export interface LayoutForces {
  gravity: number
  scalingRatio: number
  edgeWeightInfluence: number
  damping: number
}

export type ChannelDimension =
  | { source: 'frontMatter'; field: string }
  | { source: 'structural'; metric: 'degree' | 'community' | 'centrality' | 'orphan' }
  | { source: 'mechanical'; property: 'path' | 'root' | 'sizeBytes' | 'modifiedMs' }
  | { source: 'edge'; metric: 'multiplicity' | 'recency' | 'rarity' | 'overlap' | 'crossRoot' | 'origin' | 'field' }

export type ChannelValueType = 'numeric' | 'categorical' | 'temporal'

export interface ChannelBinding {
  dimension: ChannelDimension | null
  /** Resolved once at bind time and stored; never re-inferred per render. */
  valueType: ChannelValueType
}

export interface ChannelBindings {
  nodeColor: ChannelBinding
  nodeShape: ChannelBinding
  nodeSize: ChannelBinding
  edgeColor: ChannelBinding
  edgeThickness: ChannelBinding
  edgeOpacity: ChannelBinding
}

export type TagTreatment = 'off' | 'nodes' | 'filter'
export type ClusterRendering = 'hull' | 'border-tint' | 'off'

/** How a categorical rule value is compared: whole-value equality, or a leading-string match (`sections/staff/` against a path). */
export type GraphFilterMatch = 'exact' | 'prefix'

export interface GraphFilterRule {
  dimension: ChannelDimension
  mode: 'include' | 'exclude'
  /** Categorical match set. Empty means the rule is inert. */
  values?: string[]
  /** How `values` are compared. Absent means `exact`. */
  match?: GraphFilterMatch
  /** Numeric/temporal bounds, inclusive. */
  min?: number
  max?: number
}

export interface GraphViewSavedView {
  name: string
  bindings: ChannelBindings
  filters: GraphFilterRule[]
  tagTreatment: TagTreatment
  clusterRendering: ClusterRendering
  /** Whether orphan documents (no links either way) are on stage. Absent on views saved before the toggle existed, which means shown. */
  showOrphans?: boolean
  /** Whether dangling (broken-link) stubs are drawn. Absent means drawn. The badge reports them either way. */
  showDangling?: boolean
  /** Whether documents are decomposed into section nodes. Absent means the corpus's configured `sectionNodes`. */
  sectionNodes?: boolean
  /** Which configured `promotedFields` are drawn as anchor nodes. Absent means none. */
  promotedFields?: string[]
  /** Force-layout parameters. Absent means the built-in default shape. */
  forces?: LayoutForces
  /** Node id to persisted layout position. Provisional and derived identities are never written here. */
  positions: Record<string, { x: number; y: number }>
  /** Node ids held in place: excluded from the force layout and from drag follow. Absent on views saved before pins existed. */
  pinned?: string[]
}

/** A saved view plus the scope it was loaded from. Never merged across scopes. */
export interface ScopedSavedView extends GraphViewSavedView {
  source: 'project' | 'user'
}

export interface GraphViewConfig {
  corpusRoots: CorpusRootConfig[]
  identityField: string
  labelField: string
  /**
   * The front-matter field holding a document's tags. Corpora disagree
   * (`tags`, `topics`, `keywords`), so it is bound like identity and label
   * rather than hardcoded. `tagTreatment: 'nodes'` folds this field into
   * `groupFields` for the model build; without it that treatment has no
   * field to group on and silently does nothing.
   */
  tagField: string
  groupFields: string[]
  edgeFields: string[]
  hoverFields: string[]
  curatedFields: GraphViewCuratedField[]
  /** Note-descriptive properties the operator may draw as anchor nodes at view time. */
  promotedFields: GraphPromotedField[]
  savedViews: ScopedSavedView[]
  /**
   * Name of the saved view applied when the corpus first loads. Empty means
   * no default: the graph opens on the store's own initial bindings.
   *
   * A name matching no saved view is logged and ignored rather than failing
   * the load, because a corpus can ship a default whose view a later edit
   * renamed, and a graph that refuses to open is worse than one that opens
   * unstyled. When both scopes hold a view of that name the project one
   * wins, matching the order `savedViews` is concatenated in.
   */
  defaultView: string
  sectionNodes: boolean
  /**
   * The front-matter field that carries per-section topics: a list of
   * mappings, each naming a `heading` (and an `ordinal` when the heading
   * text repeats, 1-based, default 1) plus the group-field values that
   * section is about. Front matter is the only metadata surface Graph View
   * reads, so a section's subjects are declared here rather than in its
   * body.
   */
  sectionTopicsField: string
  neighborhoodDepth: number
}

/**
 * The single availability predicate in the program. True whenever
 * `corpusRoots` resolved to at least one entry — which, since Graph View is
 * enabled by default, is every conversation with a real project directory.
 * False only for the invalid-path IPC fallback (`projectPath: ''`). Pure, so
 * the main-process IPC handler and the renderer store share one definition.
 */
export function isGraphViewAvailable(config: GraphViewConfig): boolean {
  return config.corpusRoots.length > 0
}

/**
 * The "Lobes" shape: communities as separate lobes with branches and
 * peninsulas. Very little centring, a large repulsion scale. This is the
 * built-in default and one of the two presets a Forces panel offers.
 */
export const LAYOUT_FORCES_LOBES: LayoutForces = { gravity: 0.05, scalingRatio: 8, edgeWeightInfluence: 1, damping: 1 }
/**
 * The "Compact" shape: a stronger centre pull and a tighter repulsion scale,
 * the round arrangement other graph tools default to. Offered as a preset
 * so an operator who prefers it is one click away.
 */
export const LAYOUT_FORCES_COMPACT: LayoutForces = { gravity: 0.5, scalingRatio: 4, edgeWeightInfluence: 1, damping: 1 }

export const GRAPH_VIEW_DEFAULTS = {
  identityField: 'id',
  labelField: 'title',
  tagField: 'tags',
  groupFields: [] as string[],
  edgeFields: ['relates', 'supersedes', 'superseded-by'] as string[],
  hoverFields: [] as string[],
  promotedFields: [] as GraphPromotedField[],
  defaultView: '',
  sectionNodes: false,
  sectionTopicsField: 'sections',
  neighborhoodDepth: 1,
} as const

/**
 * The ONLY fields a project-scoped `.ion/settings.json` may set under
 * `desktop.graphView`. A typed allowlist, never a deep merge.
 */
export const GRAPH_VIEW_PROJECT_FIELDS = [
  'corpusRoots',
  'identityField',
  'labelField',
  'tagField',
  'groupFields',
  'edgeFields',
  'hoverFields',
  'curatedFields',
  'promotedFields',
  'savedViews',
  'defaultView',
  'sectionNodes',
  'sectionTopicsField',
  'neighborhoodDepth',
] as const
