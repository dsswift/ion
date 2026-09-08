/**
 * The animator repaints the stage on every fade frame, so how it asks for
 * that repaint is a performance contract, not a detail.
 *
 * Sigma only skips re-indexing when the refresh NAMES the items it touches:
 * `refresh({ skipIndexation: true })` alone takes the full path
 * (`fullRefresh = !opts || !opts.partialGraph`) and clears and rebuilds
 * every index, sixty times a second, with the flag ignored. This asks for
 * the fast path and pins that it keeps asking.
 */
import Graph from 'graphology'
import { describe, expect, it } from 'vitest'
import { createEmphasisAnimator } from './graph-canvas-emphasis'

interface RefreshCall {
  partialGraph?: { nodes: string[]; edges: string[] }
  skipIndexation?: boolean
}

function fakeSigma(): { sigma: unknown; calls: RefreshCall[] } {
  const graph = new Graph()
  graph.addNode('a')
  graph.addNode('b')
  graph.addUndirectedEdgeWithKey('a|b', 'a', 'b')
  const calls: RefreshCall[] = []
  return {
    calls,
    sigma: {
      getGraph: () => graph,
      refresh: (opts: RefreshCall) => calls.push(opts),
    },
  }
}

describe('createEmphasisAnimator', () => {
  it('names every node and edge so sigma actually skips indexation', () => {
    const { sigma, calls } = fakeSigma()
    const animator = createEmphasisAnimator(() => sigma as never, () => 1, () => {})

    animator.retarget({ emphasis: new Set(['a']), seeds: new Set(['a']) })

    expect(calls).toHaveLength(1)
    expect(calls[0].skipIndexation).toBe(true)
    expect(calls[0].partialGraph?.nodes.sort()).toEqual(['a', 'b'])
    // Edges too: a membership edge is revealed or hidden entirely by what
    // the fader reports for its two ends, so an unnamed edge would keep the
    // appearance it had before the hover.
    expect(calls[0].partialGraph?.edges).toEqual(['a|b'])
    animator.dispose()
  })

  it('every fade frame takes the same named path', () => {
    const { sigma, calls } = fakeSigma()
    const frames: (() => void)[] = []
    const animator = createEmphasisAnimator(() => sigma as never, (cb) => {
      frames.push(cb)
      return frames.length
    }, () => {})

    animator.retarget({ emphasis: new Set(['a']), seeds: new Set(['a']) })
    while (frames.length > 0) frames.shift()!()

    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call.skipIndexation).toBe(true)
      expect(call.partialGraph).toBeDefined()
    }
    animator.dispose()
  })

  it('does nothing at all when the stage is gone', () => {
    const animator = createEmphasisAnimator(() => null, () => 1, () => {})
    expect(() => animator.retarget({ emphasis: new Set(), seeds: new Set() })).not.toThrow()
    animator.dispose()
  })
})
