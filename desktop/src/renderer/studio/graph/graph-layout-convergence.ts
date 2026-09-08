/**
 * Convergence detection for the force layout.
 *
 * ForceAtlas2's worker supervisor exposes no energy figure, so settledness is
 * measured from what it does expose: every tick it writes the whole position
 * matrix back onto the graph in one `updateEachNodeAttributes` pass, which
 * graphology reports as a single `eachNodeAttributesUpdated` event. This
 * monitor keeps the previous tick's positions, measures how far the graph
 * moved, and calls the layout settled once that movement has stayed below a
 * threshold for a run of consecutive ticks.
 *
 * Displacement is the mean per-node distance moved, normalized by the
 * bounding-box diagonal at that tick, so the threshold is a fraction of the
 * graph's own size rather than a number of graph units — a corpus that
 * happens to lay out ten times larger does not need a different constant.
 */

import type Graph from 'graphology'

/** Mean per-node movement, as a fraction of the bounding-box diagonal, below which a tick counts as still. */
export const CONVERGENCE_THRESHOLD = 0.0005
/** Consecutive still ticks required before the layout is called settled. One quiet tick is noise. */
export const CONVERGENCE_PATIENCE = 6

export interface ConvergenceOptions {
  threshold?: number
  patience?: number
  /** Fired once, on the tick that satisfies `patience`. */
  onConverged(result: ConvergenceSample): void
  /** Fired on every tick observed, before the convergence check. */
  onSample?(sample: ConvergenceSample): void
  /** The nodes whose movement counts. Defaults to every node; a local settle watches only the nodes that are free to move. */
  ids?: readonly string[]
}

export interface ConvergenceSample {
  /** Ticks observed so far, including this one. */
  ticks: number
  /** Normalized mean displacement measured on this tick. */
  displacement: number
}

export interface ConvergenceMonitor {
  /** Latest sample, or null before the first tick. */
  last(): ConvergenceSample | null
  /**
   * Forget the still run and re-baseline on the current positions. Called
   * when the operator disturbs the graph (a drag step) so a simulation that
   * was about to be called settled is not — the disturbance has to settle
   * too. Cheap: one position read, no listener churn.
   */
  reset(): void
  /** Detach from the graph. Safe to call twice. */
  dispose(): void
}

function readPositions(graph: Graph, ids: string[], out: Float64Array): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < ids.length; i++) {
    const x = graph.getNodeAttribute(ids[i], 'x') as number
    const y = graph.getNodeAttribute(ids[i], 'y') as number
    out[i * 2] = x
    out[i * 2 + 1] = y
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Attach a convergence monitor to `graph`. The node set is captured once at
 * attach time: the supervisor respawns its worker on any node add or drop,
 * and the layout run that owns this monitor is restarted with it.
 */
export function createConvergenceMonitor(graph: Graph, options: ConvergenceOptions): ConvergenceMonitor {
  const threshold = options.threshold ?? CONVERGENCE_THRESHOLD
  const patience = options.patience ?? CONVERGENCE_PATIENCE
  const ids = options.ids ? [...options.ids] : graph.nodes()
  let previous = new Float64Array(ids.length * 2)
  let current = new Float64Array(ids.length * 2)
  readPositions(graph, ids, previous)

  let ticks = 0
  let stillRun = 0
  let last: ConvergenceSample | null = null
  let done = false

  const onTick = (): void => {
    if (done) return
    ticks++
    const bbox = readPositions(graph, ids, current)
    const diagonal = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY)

    let sum = 0
    for (let i = 0; i < ids.length; i++) {
      const dx = current[i * 2] - previous[i * 2]
      const dy = current[i * 2 + 1] - previous[i * 2 + 1]
      sum += Math.hypot(dx, dy)
    }
    const mean = ids.length > 0 ? sum / ids.length : 0
    // A degenerate graph (every node at one point) has no diagonal to
    // normalize by; treat any movement at all as "not still" rather than
    // dividing by zero.
    const displacement = diagonal > 0 ? mean / diagonal : mean > 0 ? Infinity : 0
    last = { ticks, displacement }
    options.onSample?.(last)

    const swap = previous
    previous = current
    current = swap

    if (displacement < threshold) {
      stillRun++
      if (stillRun >= patience) {
        done = true
        graph.off('eachNodeAttributesUpdated', onTick)
        options.onConverged(last)
      }
    } else {
      stillRun = 0
    }
  }

  graph.on('eachNodeAttributesUpdated', onTick)

  return {
    last: () => last,
    reset() {
      if (done) return
      stillRun = 0
      readPositions(graph, ids, previous)
    },
    dispose() {
      if (done) return
      done = true
      graph.off('eachNodeAttributesUpdated', onTick)
    },
  }
}
