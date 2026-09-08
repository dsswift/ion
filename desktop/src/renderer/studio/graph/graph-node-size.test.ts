/**
 * Pins the one size function the reducer, the graph sync, and the overlap
 * resolver all share — if they ever disagree, the resolver keeps space clear
 * for a radius that is not the one Sigma draws.
 */
import { describe, expect, it } from 'vitest'
import { nodeRenderSize } from './graph-node-size'

describe('nodeRenderSize', () => {
  it('grows with degree and saturates', () => {
    expect(nodeRenderSize('document', 10)).toBeGreaterThan(nodeRenderSize('document', 0))
    expect(nodeRenderSize('document', 10_000)).toBe(nodeRenderSize('document', 1_000_000))
  })

  it('draws dangling and section nodes as secondary', () => {
    expect(nodeRenderSize('dangling', 4)).toBeLessThan(nodeRenderSize('document', 4))
    expect(nodeRenderSize('section', 4)).toBeLessThan(nodeRenderSize('document', 4))
  })

  it('sizes a synthetic cluster off its member count, not its zero degree', () => {
    const small = nodeRenderSize('cluster', 0, 3)
    const large = nodeRenderSize('cluster', 0, 200)
    expect(small).toBeGreaterThan(nodeRenderSize('document', 0))
    expect(large).toBeGreaterThan(small)
  })

  it('never returns a non-finite or negative radius', () => {
    for (const kind of ['document', 'group', 'section', 'dangling', 'cluster']) {
      const size = nodeRenderSize(kind, -5, -5)
      expect(Number.isFinite(size)).toBe(true)
      expect(size).toBeGreaterThan(0)
    }
  })
})
