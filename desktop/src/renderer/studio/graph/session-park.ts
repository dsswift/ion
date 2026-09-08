/**
 * Graph session parking: the in-memory hold that lets a graph survive a
 * conversation switch instead of rebuilding from a cold scan.
 *
 * A graph is a picture of a directory's files, so a session is keyed by
 * directory rather than by conversation. Two conversations open on the same
 * checkout share one session — the same model, layout, selection, filters,
 * and camera — which mirrors the main process, where `corpus-store` already
 * caches one scan and one watcher per `projectPath` with reference counting.
 * A worktree is a different path, so it gets its own session, which is
 * correct: its files genuinely differ.
 *
 * Deliberately memory-only and window-local. Nothing here is written to
 * disk and nothing survives a window reload, because a parked session holds
 * a live graphology instance and a settled force layout — derived state
 * whose only value is that recomputing it is expensive. Losing it costs a
 * rebuild, never data.
 *
 * The park is not a cache with an eviction policy. An entry is released
 * when the operator closes the graph tab, which is the moment they said
 * they were finished with it.
 */

import { rDebug, rInfo } from '../../rendererLogger'
import { initialGraphData, type GraphData } from './graph-store-types'

/**
 * Everything a resumed session restores. This is the whole `GraphData`
 * shape rather than a curated subset: a field left out would silently
 * reset on every switch, which is the defect this module exists to remove.
 */
export type ParkedSession = GraphData

/**
 * Split the data half out of the full store state, which also carries the
 * action functions. The key list comes from `initialGraphData()` rather
 * than a second hand-written list, so a field added to `GraphData` is
 * parked automatically instead of being silently dropped until someone
 * notices it resetting.
 *
 * Two fields are deliberately NOT carried across as-is, because they
 * describe work owned by the canvas rather than state owned by the store,
 * and the canvas is torn down when a session parks:
 *
 * - `layoutState`. Parking mid-run stores `'running'`, but the layout
 *   engine that would later report it settled dies with the canvas. A
 *   resumed session would claim a run that no longer exists, and every
 *   camera request defers behind it forever. A parked graph is at rest by
 *   definition, so it resumes `'settled'`.
 * - `cameraRequest`. The canvas dedupes by sequence number in a component
 *   ref, which does not survive the unmount, so a carried request is either
 *   re-applied or stuck. A view loads into a fresh navigation state
 *   (§ saved views), and the same reasoning holds for a resumed one.
 */
export function extractGraphData(state: GraphData): ParkedSession {
  const keys = Object.keys(initialGraphData()) as (keyof GraphData)[]
  const out = {} as Record<keyof GraphData, unknown>
  for (const k of keys) out[k] = state[k]
  const parked = out as ParkedSession
  // Pointer state does not survive the canvas either: the `leaveNode` that
  // would clear a hover never fires on an unmounted stage, and a context
  // menu belongs to the click that opened it.
  return { ...parked, layoutState: 'settled', cameraRequest: null, layoutFree: null, hoverNodeId: null, hoverEmphasisNodeIds: new Set(), contextMenu: null, quickPeekEdgeId: null }
}

const parked = new Map<string, ParkedSession>()

/** Whether a directory has a parked session ready to resume. */
export function hasParkedSession(projectPath: string): boolean {
  return parked.has(projectPath)
}

/** Hold a directory's live state so a later return resumes instead of rebuilding. */
export function parkSession(projectPath: string, data: ParkedSession): void {
  parked.set(projectPath, data)
  rInfo('graph_view', 'graph_view: session parked', {
    projectPath,
    nodeCount: data.model?.nodes.length ?? 0,
    positionCount: data.positions.size,
    selectionCount: data.selectedNodeIds.size,
    filterCount: data.filters.length,
    parkedCount: parked.size,
  })
}

/**
 * Take a directory's parked state, removing it from the park. Removing on
 * read is what keeps the park from handing the same mutable model to two
 * owners: the resuming store becomes the sole owner until it parks again.
 */
export function resumeSession(projectPath: string): ParkedSession | null {
  const data = parked.get(projectPath)
  if (!data) return null
  parked.delete(projectPath)
  rInfo('graph_view', 'graph_view: session resumed', {
    projectPath,
    nodeCount: data.model?.nodes.length ?? 0,
    positionCount: data.positions.size,
    selectionCount: data.selectedNodeIds.size,
    parkedCount: parked.size,
  })
  return data
}

/**
 * Drop a directory's parked session without resuming it. Called when the
 * operator closes the graph tab: they are finished with that graph, so the
 * model, the layout, and the corpus subscription behind them are released.
 */
export function releaseSession(projectPath: string): boolean {
  const existed = parked.delete(projectPath)
  if (existed) {
    rDebug('graph_view', 'graph_view: session released', { projectPath, parkedCount: parked.size })
  }
  return existed
}

/** Every directory currently holding a parked session. */
export function parkedPaths(): string[] {
  return [...parked.keys()]
}

/** Drop every parked session. Test-only reset; nothing in the app clears the whole park. */
export function clearAllSessions(): void {
  parked.clear()
}
