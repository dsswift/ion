/**
 * The stage's layout engine: `createLayoutEngine` wired to the canvas's
 * refs and to the store. Every run — the first layout, a drag, a drop, a
 * pin change — reports back the same way: `running` while it goes, an
 * overlap pass after the FIRST layout only, every settled position
 * persisted, and `settled` at the end.
 *
 * Kept beside `GraphCanvas.tsx` rather than inside it so the canvas file
 * stays under the size cap; nothing here is reusable elsewhere.
 */

import type Graph from 'graphology'
import type Sigma from 'sigma'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'
import { createLayoutEngine, type LayoutEngine } from './graph-layout'
import { harvestPositions } from './graph-sigma-graph'
import { resolveNodeOverlaps } from './graph-overlap'
import type { HullOverlayHandle } from './cluster/hull-overlay'
import type { LayoutState } from './graph-store-types'
import type { LayoutForces } from '../../../shared/graph-view-types'

/**
 * Stale replies in one generation past which the log warns. One is the
 * expected shape of a restart (the reply already in flight lands after the
 * new matrix went out). The count is per restart, not cumulative: an
 * earlier cumulative threshold promoted every expected drop after the
 * eighth drag of a session to a warning that read as a restart storm.
 */
export const STALE_REPLIES_PER_RESTART_WARN_ABOVE = 1

/** What one settle's overlap pass did, plus how long it took. */
export interface SettleOverlapResult {
  iterations: number
  movedNodes: number
  remainingOverlaps: number
  overlapMs: number
}

/**
 * Re-space the nodes a settle was allowed to move.
 *
 * Every settle ends here, not just the first. The simulation's repulsion is
 * defined in graph units while the drawn radius is in screen pixels, so a
 * run can converge with nodes drawn on top of one another however it was
 * started — which is why a drop used to lose the padding the initial
 * layout had.
 *
 * What differs by run is the REACH. An unconfined run (`freeIds` null) may
 * re-space the whole stage; a confined one may only touch the nodes it was
 * allowed to move, so an arrangement the operator built outside that set is
 * never nudged by a relaxation they did not ask for. A pinned node is
 * immovable either way: it still collides, it just holds its ground. The
 * node just dropped is not in the free set, so it keeps exactly the
 * position the hand left it and its neighbours re-space around it.
 */
export function settleOverlap(
  graph: Graph,
  viewport: { width: number; height: number },
  run: { runReason: string; freeIds: ReadonlySet<string> | null; pinned: ReadonlySet<string> },
): SettleOverlapResult {
  const movable = new Set(graph.nodes().filter((id) => !run.pinned.has(id) && (!run.freeIds || run.freeIds.has(id))))
  const startedAt = Date.now()
  const result = resolveNodeOverlaps(graph, viewport, {
    movable,
    // Only the first layout arrives from a seed dense enough to hold
    // exactly-colocated nodes. A later run is refining real positions, and
    // a re-dispersal there would be a second layout rather than a
    // correction.
    skipPredisperse: run.runReason !== 'initial',
  })
  return { ...result, overlapMs: Date.now() - startedAt }
}

export interface StageEngineDeps {
  graph: Graph
  getContainer(): HTMLElement | null
  getSigma(): Sigma | null
  getHull(): HullOverlayHandle | null
  getPinned(): ReadonlySet<string>
  getForces(): LayoutForces
  setLayoutState(state: LayoutState): void
  setNodePositions(entries: Map<string, { x: number; y: number }>): void
}

export function createStageEngine(deps: StageEngineDeps): LayoutEngine {
  const { graph } = deps
  return createLayoutEngine(graph, {
    forces: deps.getForces(),
    onRun: (reason) => {
      rInfo('graph_view', 'graph_view: layout started', { nodeCount: graph.order, reason })
      deps.setLayoutState('running')
    },
    onProgress: (progress) => {
      rDebug('graph_view', 'graph_view: layout progress', { nodeCount: graph.order, ...progress })
    },
    onRestrict: (info) => {
      rDebug('graph_view', 'graph_view: layout confined', { nodeCount: graph.order, ...info })
    },
    onStaleReply: (info) => {
      const log = info.droppedSinceStart > STALE_REPLIES_PER_RESTART_WARN_ABOVE ? rWarn : rDebug
      log('graph_view', 'graph_view: stale layout reply dropped', { nodeCount: graph.order, ...info })
    },
    onCool: (cool) => {
      const container = deps.getContainer()
      let overlap: SettleOverlapResult | null = null
      if (container) {
        const rect = container.getBoundingClientRect()
        overlap = settleOverlap(graph, { width: rect.width, height: rect.height }, {
          runReason: cool.runReason,
          freeIds: cool.freeIds,
          pinned: deps.getPinned(),
        })
      }
      // Every settled position is the corpus's to remember: a rebuild
      // restores only what the store carries.
      deps.setNodePositions(harvestPositions(graph, new Map()))
      deps.getSigma()?.refresh()
      deps.getHull()?.redraw()
      // Where the time went, so a slow settle can be attributed from the
      // log: the worker's share, the main thread's write-back share, and the
      // worst single round trip of each.
      const { timing } = cool
      rInfo('graph_view', 'graph_view: layout cooled', {
        nodeCount: graph.order,
        runReason: cool.runReason,
        reason: cool.reason,
        ticks: cool.ticks,
        freeCount: cool.freeCount,
        finalDisplacement: cool.finalDisplacement,
        durationMs: cool.durationMs,
        roundTrips: timing.roundTrips,
        workerMs: Math.round(timing.workerMs),
        writeBackMs: Math.round(timing.writeBackMs),
        maxRoundTripMs: Math.round(timing.maxRoundTripMs),
        maxWriteBackMs: Math.round(timing.maxWriteBackMs),
        msPerRoundTrip: timing.roundTrips > 0 ? Math.round((timing.workerMs + timing.writeBackMs) / timing.roundTrips) : 0,
        ...(overlap ? { overlapMs: overlap.overlapMs, overlapIterations: overlap.iterations, overlapMovedNodes: overlap.movedNodes, remainingOverlaps: overlap.remainingOverlaps } : {}),
      })
      deps.setLayoutState('settled')
    },
  })
}
