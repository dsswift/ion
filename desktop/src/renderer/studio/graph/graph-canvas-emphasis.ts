/**
 * Drives the emphasis fader from the render layer: when the target changes
 * the animator steps the fader once per animation frame and refreshes the
 * stage after each step, until every level has settled. Sigma's reducers
 * read the fader's levels on every call, so a refresh is all a step needs.
 *
 * Each refresh is kept to a reducer pass: nothing structural changes during
 * a fade, and re-indexing the graph sixty times a second is the cost worth
 * avoiding. Sigma only takes that path when a refresh names the items it
 * touches — `refresh({ skipIndexation: true })` on its own sets
 * `fullRefresh` and clears and rebuilds every node and edge index anyway,
 * with the flag ignored (see its `refresh`: `fullRefresh = !opts ||
 * !opts.partialGraph`). So the whole graph is named explicitly, which is
 * what makes the flag mean anything.
 */

import type Sigma from 'sigma'
import { createEmphasisFader, type EmphasisFader, type EmphasisTarget } from './selection/emphasis-fade'

export interface EmphasisAnimator {
  readonly fader: EmphasisFader
  /** Replace the target; starts the frame loop if anything has to move. */
  retarget(target: EmphasisTarget): void
  /** Stop the loop. The fader keeps its levels. */
  dispose(): void
}

export function createEmphasisAnimator(getSigma: () => Sigma | null, requestFrame: (cb: () => void) => number = (cb) => requestAnimationFrame(cb), cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id)): EmphasisAnimator {
  const fader = createEmphasisFader()
  let frame: number | null = null

  /**
   * Repaint every item through the reducers without touching the indices.
   * Edges are named as well as nodes: an edge's appearance follows the
   * emphasis too, and a membership edge is revealed or hidden entirely by
   * what the fader reports for its two ends.
   */
  const repaint = (): void => {
    const sigma = getSigma()
    if (!sigma) return
    const graph = sigma.getGraph()
    sigma.refresh({ partialGraph: { nodes: graph.nodes(), edges: graph.edges() }, skipIndexation: true })
  }

  const tick = (): void => {
    frame = null
    const moving = fader.step()
    repaint()
    if (moving) frame = requestFrame(tick)
  }

  return {
    fader,
    retarget(target) {
      const needsStep = fader.setTarget(target)
      // A target that changed nothing about the levels still changes what
      // the reducers read for untracked nodes, so the stage refreshes once.
      repaint()
      if (needsStep && frame === null) frame = requestFrame(tick)
    },
    dispose() {
      if (frame !== null) cancelFrame(frame)
      frame = null
    },
  }
}
