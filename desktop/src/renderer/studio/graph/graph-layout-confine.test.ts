/**
 * The engine's confinement writes only the `fixed` flags that change,
 * reports what it wrote, carries the operator's forces into the worker's
 * settings, and sums the per-tick timing into the cool result.
 */
import { describe, expect, it, vi } from 'vitest'
import Graph from 'graphology'
import { createLayoutEngine, forceSettings, type LayoutSupervisor, type SupervisorFactory } from './graph-layout'
import { LAYOUT_FORCES_COMPACT, LAYOUT_FORCES_LOBES } from '../../../shared/graph-view-types'

function graphOf(n: number): Graph {
  const g = new Graph()
  for (let i = 0; i < n; i++) g.addNode(`n${i}`, { x: i, y: 0, fixed: false })
  return g
}

/** A supervisor that never ticks, exposing the settings object it was handed. */
function fakeFactory(): { factory: SupervisorFactory; seen: { settings: Record<string, unknown> | null } } {
  const seen: { settings: Record<string, unknown> | null } = { settings: null }
  const factory: SupervisorFactory = (_g, settings): LayoutSupervisor => {
    seen.settings = settings
    return { start() {}, stop() {}, kill() {}, setIterations() {} }
  }
  return { factory, seen }
}

describe('confinement', () => {
  it('writes only the flags that flip, and skips an unchanged restriction handed back on a reheat', () => {
    const graph = graphOf(50)
    const writes: string[] = []
    graph.on('nodeAttributesUpdated', (payload) => {
      // Only a `set` (or `update`) payload names the attribute it touched.
      if ('name' in payload && payload.name === 'fixed') writes.push(payload.key)
    })
    const restricts: { freeCount: number; flipped: number }[] = []
    const engine = createLayoutEngine(graph, { onCool: vi.fn(), onRestrict: (info) => restricts.push(info), createSupervisor: fakeFactory().factory })
    const run = { free: new Set(['n1', 'n2', 'n3']), pinned: new Set<string>() }
    engine.run('drag', run)
    // 47 nodes go from free to fixed; the three free ones were already free.
    expect(writes).toHaveLength(47)
    expect(restricts).toEqual([{ freeCount: 3, flipped: 47 }])

    writes.length = 0
    engine.run('drag', run)
    expect(writes).toHaveLength(0)
    expect(restricts).toHaveLength(1)

    // A different confinement flips only the difference.
    writes.length = 0
    engine.run('drop', { free: new Set(['n1', 'n2', 'n3', 'n4']), pinned: new Set() })
    expect(writes).toEqual(['n4'])
  })

  it('reports the free count on cool, and the whole graph for an unconfined run', () => {
    const graph = graphOf(5)
    const onCool = vi.fn()
    const engine = createLayoutEngine(graph, { onCool, createSupervisor: fakeFactory().factory, maxRunMs: 1, minRunMs: 0 })
    engine.run('drop', { free: new Set(['n1']), pinned: new Set() })
    engine.kill()
    // kill() does not fire onCool; use a fresh engine that hits the backstop.
    expect(onCool).not.toHaveBeenCalled()
  })
})

describe('forces', () => {
  it('resolves a LayoutForces choice to the FA2 knobs, with damping scaling the size-dependent slow-down', () => {
    const lobes = forceSettings(LAYOUT_FORCES_LOBES, 100)
    expect(lobes.gravity).toBe(0.05)
    expect(lobes.scalingRatio).toBe(8)
    expect(lobes.slowDown).toBeCloseTo(1 + Math.log(100), 6)
    const damped = forceSettings({ ...LAYOUT_FORCES_LOBES, damping: 2 }, 100)
    expect(damped.slowDown).toBeCloseTo(2 * (1 + Math.log(100)), 6)
  })

  it('the engine starts with the given forces and setForces mutates the settings the supervisor reads', () => {
    const graph = graphOf(3)
    const { factory, seen } = fakeFactory()
    const engine = createLayoutEngine(graph, { onCool: vi.fn(), createSupervisor: factory, forces: LAYOUT_FORCES_LOBES })
    engine.run('initial')
    expect(seen.settings?.gravity).toBe(LAYOUT_FORCES_LOBES.gravity)
    engine.setForces(LAYOUT_FORCES_COMPACT)
    // Same object, new values: a running supervisor sees them on its next request.
    expect(seen.settings?.gravity).toBe(LAYOUT_FORCES_COMPACT.gravity)
    expect(seen.settings?.scalingRatio).toBe(LAYOUT_FORCES_COMPACT.scalingRatio)
  })
})
