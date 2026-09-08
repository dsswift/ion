/**
 * Corpus lifecycle slice: subscribe on init, apply live deltas and config
 * changes, rebuild the model, and tear everything down on dispose. This is
 * the only slice that talks to the preload bridge for corpus data, and the
 * only place the graphology instance is (re)built.
 */

import { buildGraphModel } from '../../../shared/graph-model'
import { rDebug, rInfo, rWarn, rError } from '../../rendererLogger'
import { syncSigmaGraph, harvestPositions } from './graph-sigma-graph'
import { computeVisibility } from './filter/visibility'
import { buildSearchIndex } from './search/search-index'
import { computeEmphasis } from './selection/emphasis'
import { useSurfaceStore } from '../surface/surface-store'
import { lastEditorFilePath } from '../surface/editor-anchor'
import { isGraphViewAvailable, type GraphViewConfig, type ChannelBindings } from '../../../shared/graph-view-types'
import type { CorpusDelta, CorpusSnapshot } from '../../../shared/graph-corpus-types'
import type { GraphModel } from '../../../shared/graph-model-types'
import { extractGraphData, parkSession, releaseSession, resumeSession } from './session-park'
import { initialGraphData, sampleValues, type ChannelName, type GraphState, type StoreGet, type StoreSet } from './graph-store-types'

let unsubscribeDelta: (() => void) | null = null
let unsubscribeConfigChanged: (() => void) | null = null
let initGeneration = 0

/**
 * Attach the live delta and config-changed listeners for whatever project
 * the store currently holds. Both the cold-scan path and the resume path
 * need exactly these, so they share one definition: a resumed session that
 * re-attached only one of them would silently stop tracking the other.
 */
function attachSubscriptions(get: StoreGet): void {
  unsubscribeDelta?.()
  unsubscribeConfigChanged?.()
  unsubscribeDelta = window.ion.onGraphCorpusDelta((deltaProjectPath, delta) => {
    if (deltaProjectPath !== get().projectPath) return
    get().applyDelta(delta)
  })
  unsubscribeConfigChanged = window.ion.onGraphViewConfigChanged((changedProjectPath, nextConfig) => {
    if (changedProjectPath !== get().projectPath) return
    get().applyConfig(nextConfig)
  })
}

/** Detach the live listeners without touching the store or the subscription. */
function detachSubscriptions(): void {
  unsubscribeDelta?.()
  unsubscribeDelta = null
  unsubscribeConfigChanged?.()
  unsubscribeConfigChanged = null
}

/**
 * The file this conversation most recently had open in the editor.
 *
 * Deliberately NOT the currently active tab. In the Studio surface the
 * graph and the editor are tabs in one strip, so opening the graph makes
 * the graph active — reading the active tab would ask "is the graph a file"
 * and always answer no. That is exactly why the neighborhood opening scope
 * never ran: every launch logged `anchorId: null` and fell back to the
 * whole corpus.
 */
function anchorEditorFilePath(): string | null {
  return lastEditorFilePath(useSurfaceStore.getState().currentConversationId)
}

/** The document node whose `path` matches the active editor's open file, or null. */
function nodeIdForPath(model: GraphModel, path: string | null): string | null {
  if (!path) return null
  return model.nodes.find((n) => n.kind === 'document' && n.path === path)?.id ?? null
}

export function recomputeVisibility(get: StoreGet, set: StoreSet): void {
  const { model, graph, filters, scope, showOrphans, showDangling, hiddenNodeIds } = get()
  if (!model || !graph) return
  const visibleNodeIds = computeVisibility(model, graph, filters, scope, { showOrphans, showDangling, hiddenNodeIds })
  set({ visibleNodeIds })
  rInfo('graph_view', 'graph_view: filter changed', {
    ruleCount: filters.length,
    showOrphans,
    showDangling,
    hiddenNodes: hiddenNodeIds.size,
    visibleCount: visibleNodeIds.size,
    hiddenCount: model.nodes.length - visibleNodeIds.size,
  })
}

/**
 * Re-project after anything that changes WHAT IS VISIBLE: a scope change, a
 * filter edit, a per-node hide, an orphan or dangling toggle.
 *
 * Normally that is only a visibility recompute — the model is the same, the
 * projection over it moves. Section nodes break that symmetry: the model
 * decomposes the documents in view, so the visible set is an INPUT to the
 * build and a scope change genuinely produces a different model. Narrowing
 * to a neighbourhood is exactly how an operator gets sections on a corpus
 * too wide to decompose whole, so it has to rebuild or the toggle looks
 * broken at every scope.
 *
 * No recursion: the section pass calls `computeVisibility` (pure) rather
 * than back into this.
 */
export function reprojectAfterVisibilityChange(get: StoreGet, set: StoreSet): void {
  if (get().sectionNodes) rebuildAndSync(get, set, false)
  else recomputeVisibility(get, set)
}

/**
 * Section decomposition multiplies a corpus by the headings it carries: on
 * a 2,192-document corpus turning it on produced 39,200 nodes and 39,961
 * edges — a graph that stutters under the simulation and cannot be read
 * once it settles. Sections are a way to look INSIDE the documents in
 * front of you, so they decompose the documents in view and never a whole
 * corpus.
 *
 * "In view" is resolved precisely rather than guessed: the document-level
 * model is built first, real visibility (scope, filters, orphan and
 * dangling toggles, hidden nodes) is computed on it, and the surviving
 * documents are what decompose. A prior render's visible set would be a
 * stale approximation, and the first render has none at all.
 *
 * The guard counts SECTIONS, not documents, because sections are what the
 * simulation and the renderer actually carry. Documents vary enormously in
 * how many headings they hold — in the corpus above, forty documents alone
 * carried 1,482 — so a document-count limit bounds nothing. Above the
 * budget the answer is to withhold and say so: narrowing the scope is what
 * makes sections meaningful, and a notice names that remedy instead of
 * leaving the toggle looking broken.
 */
export const SECTION_NODE_BUDGET = 2000

export interface SectionScopeNotice {
  /** Sections the documents in view would have produced. */
  sectionCount: number
  /** Documents in view that carry them. */
  documentCount: number
  budget: number
}

interface SectionScope {
  documentIds: ReadonlySet<string> | null
  withheld: SectionScopeNotice | null
}

function resolveSectionScope(
  get: StoreGet,
  snapshot: CorpusSnapshot,
  config: GraphViewConfig,
  logger: { debug: (msg: string, fields?: Record<string, unknown>) => void },
  promotedFields: ReadonlySet<string>,
): SectionScope {
  // Pass one: the same model without sections, purely to learn which
  // documents are in view.
  const { model, graph } = buildGraphModel(snapshot, { ...config, sectionNodes: false }, logger, { promotedFields })
  const { filters, scope, showOrphans, showDangling, hiddenNodeIds } = get()
  const visible = computeVisibility(model, graph, filters, scope, { showOrphans, showDangling, hiddenNodeIds })
  const documentIds = new Set<string>()
  for (const node of model.nodes) {
    if (node.kind === 'document' && visible.has(node.id)) documentIds.add(node.id)
  }
  // Count the headings those documents actually carry, from the snapshot
  // that is about to be built — the same source the decomposition reads,
  // so the projection cannot disagree with the result.
  const idByPath = new Map(model.nodes.filter((n) => n.kind === 'document' && n.path).map((n) => [n.path as string, n.id]))
  let sectionCount = 0
  for (const doc of snapshot.documents) {
    const id = idByPath.get(doc.path)
    if (id && documentIds.has(id)) sectionCount += doc.sections.length
  }

  if (sectionCount > SECTION_NODE_BUDGET) {
    rInfo('graph_view', 'graph_view: section nodes withheld, scope too wide', {
      sectionCount,
      documentCount: documentIds.size,
      budget: SECTION_NODE_BUDGET,
      scopeMode: scope.mode,
      ruleCount: filters.length,
    })
    return { documentIds: new Set(), withheld: { sectionCount, documentCount: documentIds.size, budget: SECTION_NODE_BUDGET } }
  }
  rDebug('graph_view', 'graph_view: section scope resolved', {
    sectionCount,
    documentCount: documentIds.size,
    scopeMode: scope.mode,
    ruleCount: filters.length,
  })
  return { documentIds, withheld: null }
}

/**
 * Rebuild the model from the snapshot and the view-time layer choices, and
 * sync the graphology instance to it.
 *
 * `restartLayout: true` asks for a whole-graph layout (the first build).
 * Otherwise, when the rebuild ADDS nodes — a tag treatment, an anchor, or a
 * section toggle switched on — the new nodes are placed beside their
 * neighbours by the sync and a run confined to them plus what they touch
 * is requested, so the additions settle into the arrangement the operator
 * has instead of the whole corpus re-laying out around them. A rebuild
 * that only removes nodes needs no run: the survivors are already at rest.
 */
export function rebuildAndSync(get: StoreGet, set: StoreSet, restartLayout: boolean): void {
  const { snapshot, config, tagTreatment, sectionNodes, promotedFields } = get()
  if (!snapshot || !config) return

  const previousGraph = get().graph
  const positions = harvestPositions(previousGraph, get().positions)

  // 'nodes' tag treatment folds the tag field into groupFields for this
  // build only, reusing child 04's group mechanism rather than a second
  // grouping code path. The field comes from config, which every corpus
  // resolves: a store-local override that nothing ever set made this
  // treatment a silent no-op. 'filter' and 'off' both leave the node set
  // alone — under 'filter' the field stays bindable in the filter panel,
  // which needs no model change because filtering reads front matter
  // directly.
  const tagField = config.tagField
  const groupFields =
    tagTreatment === 'nodes' && tagField && !config.groupFields.includes(tagField) ? [...config.groupFields, tagField] : config.groupFields
  // Section decomposition is a view-time layer: the store's flag, seeded
  // from config on init, is what the build reads.
  const effectiveConfig = groupFields === config.groupFields && sectionNodes === config.sectionNodes ? config : { ...config, groupFields, sectionNodes }

  const buildStarted = Date.now()
  const logger = { debug: (msg: string, fields?: Record<string, unknown>) => rDebug('graph_view', msg, fields) }
  const sectionScope = sectionNodes
    ? resolveSectionScope(get, snapshot, effectiveConfig, logger, promotedFields)
    : { documentIds: null, withheld: null }
  const { model, graph } = buildGraphModel(snapshot, effectiveConfig, logger, {
    promotedFields,
    sectionDocumentIds: sectionScope.documentIds,
  })
  rDebug('graph_view', 'graph_view: model rendered', {
    nodeCount: model.nodes.length,
    edgeCount: model.edges.length,
    danglingCount: model.dangling.length,
    sectionNodes,
    sectionDocuments: sectionScope.documentIds ? sectionScope.documentIds.size : -1,
    promotedFields: [...promotedFields].join(','),
    buildMs: Date.now() - buildStarted,
  })
  set({ sectionScopeNotice: sectionScope.withheld })

  syncSigmaGraph(
    graph,
    model,
    positions,
    (nodeId, origin, pos) => {
      rError('graph_view', 'graph_view: invalid node position repaired', { nodeId, origin, x: pos?.x, y: pos?.y })
    },
    get().pinnedNodeIds,
  )
  // The emphasis set is derived from the graph; a rebuild hands back a new
  // instance, so it is recomputed here against the surviving selection.
  set({ model, graph, positions, searchIndex: buildSearchIndex(model), emphasisNodeIds: computeEmphasis(graph, get().selectedNodeIds) })

  const { bindings } = get()
  const domainSizes: Record<string, number> = {}
  for (const [channel, binding] of Object.entries(bindings) as [ChannelName, ChannelBindings[ChannelName]][]) {
    if (!binding.dimension) continue
    const sampled = sampleValues(channel, binding.dimension, model)
    domainSizes[channel] = new Set(sampled.filter((v) => v !== null && v !== undefined && v !== '').map(String)).size
  }
  rDebug('graph_view', 'graph_view: scale domains computed', domainSizes)

  recomputeVisibility(get, set)

  if (restartLayout) {
    rInfo('graph_view', 'graph_view: layout requested', { nodeCount: model.nodes.length, confined: false })
    set({ layoutState: 'requested', layoutFree: null })
    return
  }
  // Only nodes the previous graph did not hold need to find a place; a
  // rebuild from a corpus delta or a layer toggle that removed nodes leaves
  // everything else where it settled.
  if (previousGraph) {
    const free = new Set<string>()
    for (const n of model.nodes) {
      if (previousGraph.hasNode(n.id)) continue
      free.add(n.id)
      for (const neighbour of graph.neighbors(n.id)) free.add(neighbour)
    }
    for (const id of get().pinnedNodeIds) free.delete(id)
    if (free.size > 0) {
      rInfo('graph_view', 'graph_view: layout requested', { nodeCount: model.nodes.length, confined: true, freeCount: free.size })
      set({ layoutState: 'requested', layoutFree: free })
    }
  }
}

export function createCorpusActions(set: StoreSet, get: StoreGet): Pick<GraphState, 'checkAvailability' | 'init' | 'applyDelta' | 'applyConfig' | 'dispose' | 'closeSession'> {
  return {
    async checkAvailability(projectPath: string) {
      if (!projectPath || projectPath === '~') return
      try {
        const config = await window.ion.graphViewGetConfig(projectPath)
        // Only update `available` when no full session is active for a
        // DIFFERENT project — a live `init()` for this same path already
        // keeps `available` current, and overwriting it here with a
        // config-only fetch for another tab's project would be wrong.
        if (get().projectPath === null || get().projectPath === projectPath) {
          set({ available: isGraphViewAvailable(config) })
        }
      } catch {
        // silent-ok: availability-only probe; the "+" menu simply omits the
        // entry until a later probe succeeds.
      }
    },

    async init(projectPath: string) {
      const generation = ++initGeneration
      const ownsInit = (): boolean => generation === initGeneration && get().projectPath === projectPath
      // A parked session for this directory resumes whole: model, settled
      // layout, selection, filters, and bindings all come back exactly as
      // the operator left them, and no layout run is requested. The main
      // process still holds the corpus subscription (it was never released
      // on park), so the snapshot in hand is current and the live delta
      // subscription below simply re-attaches.
      const resumed = resumeSession(projectPath)
      if (resumed) {
        set(resumed)
        attachSubscriptions(get)
        rInfo('graph_view', 'graph_view: surface mounted', {
          projectPath,
          rootCount: resumed.config?.corpusRoots.length ?? 0,
          watchState: resumed.watchState ?? 'unknown',
          resumed: true,
          nodeCount: resumed.model?.nodes.length ?? 0,
        })
        return
      }

      set({ projectPath, error: null })
      try {
        const config = await window.ion.graphViewGetConfig(projectPath)
        if (!ownsInit()) return
        const available = isGraphViewAvailable(config)
        set({ config, available })

        if (!available) {
          rInfo('graph_view', 'graph_view: surface mounted', { projectPath, rootCount: 0, watchState: 'unavailable' })
          return
        }

        const snapshot = await window.ion.graphCorpusSubscribe(projectPath)
        if (!ownsInit()) {
          void window.ion.graphCorpusUnsubscribe(projectPath)
          return
        }
        // The section layer starts where the corpus configured it; from
        // here on it is the operator's toggle.
        set({ snapshot, watchState: snapshot.watchState ?? null, sectionNodes: config.sectionNodes })
        rInfo('graph_view', 'graph_view: surface mounted', {
          projectPath,
          rootCount: config.corpusRoots.length,
          watchState: snapshot.watchState ?? 'unknown',
        })

        rebuildAndSync(get, set, true)

        // A configured default view is applied before the opening scope is
        // chosen, because a view carries filters and pinned positions that
        // the scope decision reads. A named view that no longer exists is
        // logged and skipped: a corpus can ship a default whose view a later
        // edit renamed, and a graph that refuses to open is worse than one
        // that opens unstyled.
        if (config.defaultView) {
          const view = config.savedViews.find((v) => v.name === config.defaultView)
          if (view) {
            get().loadView(view)
          } else {
            rWarn('graph_view', 'graph_view: default view not found', {
              projectPath,
              defaultView: config.defaultView,
              availableViews: config.savedViews.map((v) => v.name).join(','),
            })
          }
        }

        // Opening scope: the local neighborhood of the document open in the
        // active editor tab, at config.neighborhoodDepth. With no editor
        // document open, or the open document not in the corpus, scope
        // defaults to the whole corpus.
        const editorPath = anchorEditorFilePath()
        const anchorId = get().model ? nodeIdForPath(get().model!, editorPath) : null
        if (anchorId) {
          get().setScopeToNeighborhood(anchorId, config.neighborhoodDepth)
        } else {
          if (editorPath) {
            rDebug('graph_view', 'graph_view: scope changed', { mode: 'corpus', reason: 'anchor-not-in-corpus' })
          }
          get().setScopeToCorpus()
        }

        attachSubscriptions(get)
      } catch (err) {
        if (!ownsInit()) return
        rWarn('graph_view', 'graph_view: init failed', { projectPath, error: String(err) })
        set({ error: String(err) })
      }
    },

    applyDelta(delta: CorpusDelta) {
      const { snapshot, selectedNodeIds } = get()
      if (!snapshot) return

      const byPath = new Map(snapshot.documents.map((d) => [d.path, d]))
      for (const d of delta.upserted) byPath.set(d.path, d)
      for (const p of delta.removedPaths) byPath.delete(p)

      // A delta may carry a new corpus-wide watch state (a root's
      // subscription failed after the initial snapshot); otherwise the
      // previous state stands.
      const watchState = delta.watchState ?? snapshot.watchState
      const nextSnapshot: CorpusSnapshot = {
        revision: delta.revision,
        roots: delta.roots,
        documents: [...byPath.values()],
        ...(watchState ? { watchState } : {}),
      }
      set({ snapshot: nextSnapshot, watchState: watchState ?? null })
      rDebug('graph_view', 'graph_view: delta applied', {
        revision: delta.revision,
        upsertedCount: delta.upserted.length,
        removedCount: delta.removedPaths.length,
        watchState: watchState ?? 'unknown',
      })

      rebuildAndSync(get, set, false)

      // A removed document leaves the selection; what remains keeps its emphasis.
      const graph = get().graph
      const surviving = new Set([...selectedNodeIds].filter((id) => graph?.hasNode(id)))
      if (surviving.size !== selectedNodeIds.size) {
        set({ selectedNodeIds: surviving, emphasisNodeIds: computeEmphasis(graph, surviving) })
        rDebug('graph_view', 'graph_view: selection changed', { selectedCount: surviving.size, emphasisCount: get().emphasisNodeIds.size, mode: 'pruned' })
      }
    },

    applyConfig(config: GraphViewConfig) {
      set({ config, available: isGraphViewAvailable(config) })
      rebuildAndSync(get, set, false)
    },

    dispose() {
      initGeneration++
      detachSubscriptions()
      const data = get()
      const { projectPath } = data
      // Switching conversations parks the session rather than destroying
      // it: the graph is a picture of a directory, and the directory has
      // not changed just because the operator looked somewhere else.
      // Rebuilding here is what forced a cold scan and a full layout replay
      // on every switch. The corpus subscription is deliberately NOT
      // released, so the main process keeps the scan warm and the watcher
      // running; `closeSession` is what gives it back.
      if (projectPath && data.model) {
        parkSession(projectPath, extractGraphData(data))
      } else if (projectPath) {
        // Nothing worth parking (init failed, or no corpus): release the
        // reference now rather than leaking it until the tab closes.
        void window.ion.graphCorpusUnsubscribe(projectPath)
      }
      rInfo('graph_view', 'graph_view: surface unmounted', { projectPath: projectPath ?? 'none', parked: Boolean(projectPath && data.model) })
      set(initialGraphData())
    },

    closeSession(projectPath: string) {
      // The operator closed the graph tab, so they are finished with this
      // directory's graph: drop the parked state and hand the corpus
      // reference back. This is the only path that releases a subscription
      // taken by `init`.
      const wasParked = releaseSession(projectPath)
      const isLive = get().projectPath === projectPath
      if (isLive) {
        detachSubscriptions()
        set(initialGraphData())
      }
      if (wasParked || isLive) {
        void window.ion.graphCorpusUnsubscribe(projectPath)
      }
      rInfo('graph_view', 'graph_view: session closed', { projectPath, wasParked, wasLive: isLive })
    },
  }
}
