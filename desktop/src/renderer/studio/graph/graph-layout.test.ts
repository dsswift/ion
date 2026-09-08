/**
 * Pins the seed, which is the half of the layout that decides what shape
 * the simulation refines, and the warm engine: a run ends when the graph
 * converges (the budget is a backstop only), a run can be reheated by a
 * disturbance, the worker is paused rather than killed between runs, and a
 * held node is restored to the cursor on every write-back. The real FA2
 * supervisor owns a Web Worker, which jsdom does not provide, so the engine
 * is driven through its `createSupervisor` seam with a fake that performs
 * the same write-back the worker's does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Graph from 'graphology'
import { CONVERGENCE_PATIENCE } from './graph-layout-convergence'
import { createLayoutEngine, seedPositions, type LayoutSupervisor, ITERATIONS_BY_REASON, MIN_RUN_MS } from './graph-layout'

function spanOf(graph: Graph): number {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  graph.forEachNode((_id, a) => {
    minX = Math.min(minX, a.x as number)
    maxX = Math.max(maxX, a.x as number)
    minY = Math.min(minY, a.y as number)
    maxY = Math.max(maxY, a.y as number)
  })
  return Math.max(maxX - minX, maxY - minY)
}

describe('seedPositions', () => {
  it('spreads unpositioned nodes instead of piling them at one point', () => {
    const graph = new Graph()
    for (let i = 0; i < 50; i++) graph.addNode(`n${i}`, { size: 6 })

    const seeded = seedPositions(graph, new Set())

    expect(seeded).toBe(50)
    const seen = new Set<string>()
    graph.forEachNode((_id, a) => {
      expect(Number.isFinite(a.x)).toBe(true)
      expect(Number.isFinite(a.y)).toBe(true)
      seen.add(`${a.x}|${a.y}`)
    })
    expect(seen.size).toBe(50)
    expect(spanOf(graph)).toBeGreaterThan(0)
  })

  it('leaves carried positions alone and seeds only the rest', () => {
    const graph = new Graph()
    graph.addNode('kept', { x: 10, y: 20, size: 6 })
    graph.addNode('fresh', { size: 6 })

    const seeded = seedPositions(graph, new Set(['kept']))

    expect(seeded).toBe(1)
    expect(graph.getNodeAttribute('kept', 'x')).toBe(10)
    expect(graph.getNodeAttribute('kept', 'y')).toBe(20)
    expect(Number.isFinite(graph.getNodeAttribute('fresh', 'x'))).toBe(true)
  })

  it('is deterministic', () => {
    const build = (): Graph => {
      const g = new Graph()
      for (let i = 0; i < 20; i++) g.addNode(`n${i}`, { size: 5 })
      return g
    }
    const a = build()
    const b = build()
    seedPositions(a, new Set())
    seedPositions(b, new Set())
    a.forEachNode((id, attrs) => {
      expect(attrs.x).toBe(b.getNodeAttribute(id, 'x'))
      expect(attrs.y).toBe(b.getNodeAttribute(id, 'y'))
    })
  })
})

describe('seedPositions — community separation', () => {
  // Regression: seeding every node onto ONE uniform disc gave the
  // simulation a disc to refine, and a few seconds of ForceAtlas2 refines a
  // disc into a slightly better disc. The corpus rendered as one filled
  // circle with no communities, branches or peninsulas visible. The seed
  // has to carry the structure the layout is meant to reveal.
  function twoCommunities(): Graph {
    const g = new Graph()
    for (let i = 0; i < 40; i++) g.addNode(`a${i}`, { size: 4, community: 0 })
    for (let i = 0; i < 40; i++) g.addNode(`b${i}`, { size: 4, community: 1 })
    return g
  }

  function centroid(graph: Graph, prefix: string): { x: number; y: number } {
    let x = 0
    let y = 0
    let n = 0
    graph.forEachNode((id, a) => {
      if (!id.startsWith(prefix)) return
      x += a.x as number
      y += a.y as number
      n++
    })
    return { x: x / n, y: y / n }
  }

  function spread(graph: Graph, prefix: string): number {
    const c = centroid(graph, prefix)
    let worst = 0
    graph.forEachNode((id, a) => {
      if (!id.startsWith(prefix)) return
      worst = Math.max(worst, Math.hypot((a.x as number) - c.x, (a.y as number) - c.y))
    })
    return worst
  }

  it('puts two communities in separate places, not one blended disc', () => {
    const g = twoCommunities()
    seedPositions(g, new Set())

    const a = centroid(g, 'a')
    const b = centroid(g, 'b')
    const between = Math.hypot(a.x - b.x, a.y - b.y)
    expect(between).toBeGreaterThan(Math.max(spread(g, 'a'), spread(g, 'b')))
  })

  it('keeps the members of one community together', () => {
    const g = twoCommunities()
    seedPositions(g, new Set())

    const a = centroid(g, 'a')
    g.forEachNode((id, attrs) => {
      if (!id.startsWith('a')) return
      expect(Math.hypot((attrs.x as number) - a.x, (attrs.y as number) - a.y)).toBeLessThanOrEqual(spread(g, 'a') + 1e-6)
    })
  })

  it('groups nodes with no community together rather than scattering them', () => {
    const g = new Graph()
    for (let i = 0; i < 20; i++) g.addNode(`c${i}`, { size: 4, community: 0 })
    for (let i = 0; i < 5; i++) g.addNode(`none${i}`, { size: 4 })

    seedPositions(g, new Set())

    const none = centroid(g, 'none')
    const community = centroid(g, 'c')
    expect(Math.hypot(none.x - community.x, none.y - community.y)).toBeGreaterThan(0)
    expect(spread(g, 'none')).toBeLessThan(spread(g, 'c') * 2)
  })
})

describe('createLayoutEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  interface FakeSup extends LayoutSupervisor {
    ticks: number
    starts: number
    stops: number
    kills: number
    iterations: number
  }

  /**
   * Ticks every 16 ms while started: moves every node by `stepPerTick()` and
   * writes back exactly the way FA2's supervisor does — matrix onto attrs,
   * then the output reducer, then the graph read back into the "matrix".
   */
  function fakeSupervisor(stepPerTick: () => number): { factory: (graph: Graph, settings: Record<string, unknown>, reducer: (k: string, a: Record<string, unknown>) => Record<string, unknown>) => FakeSup; sup: () => FakeSup } {
    let created: FakeSup | null = null
    const factory = (graph: Graph, _settings: Record<string, unknown>, reducer: (k: string, a: Record<string, unknown>) => Record<string, unknown>): FakeSup => {
      let interval: ReturnType<typeof setInterval> | null = null
      // The worker's matrix: positions as the worker believes them.
      const matrix = new Map<string, { x: number; y: number }>()
      const sup: FakeSup = {
        ticks: 0,
        starts: 0,
        stops: 0,
        kills: 0,
        iterations: 0,
        setIterations(count) {
          sup.iterations = count
        },
        start() {
          sup.starts++
          matrix.clear()
          graph.forEachNode((id, a) => matrix.set(id, { x: a.x as number, y: a.y as number }))
          interval = setInterval(() => {
            sup.ticks++
            const step = stepPerTick()
            graph.updateEachNodeAttributes((id, a) => {
              const m = matrix.get(id)!
              if (a.fixed !== true) {
                m.x += step
                m.y += step
              }
              return reducer(id, { ...a, x: m.x, y: m.y })
            })
            graph.forEachNode((id, a) => matrix.set(id, { x: a.x as number, y: a.y as number }))
          }, 16)
        },
        stop() {
          sup.stops++
          if (interval) clearInterval(interval)
          interval = null
        },
        kill() {
          sup.kills++
          sup.stop()
        },
      }
      created = sup
      return sup
    }
    return { factory, sup: () => created! }
  }

  function graphOf(n: number): Graph {
    const graph = new Graph()
    for (let i = 0; i < n; i++) graph.addNode(`n${i}`, { x: (i % 10) * 100, y: Math.floor(i / 10) * 100, size: 6 })
    return graph
  }

  it('a settling run ends with reason converged, after the minimum run, and pauses the worker', () => {
    const graph = graphOf(50)
    const onCool = vi.fn()
    const onRun = vi.fn()
    let n = 0
    const { factory, sup } = fakeSupervisor(() => (n++ < 10 ? 30 : 0.01))
    const engine = createLayoutEngine(graph, { onCool, onRun, minRunMs: 400, maxRunMs: 20000, createSupervisor: factory })
    engine.run('initial')
    expect(onRun).toHaveBeenCalledWith('initial')

    vi.advanceTimersByTime(300)
    expect(onCool).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(onCool).toHaveBeenCalledTimes(1)
    const result = onCool.mock.calls[0][0]
    expect(result).toMatchObject({ reason: 'converged', runReason: 'initial' })
    expect(result.durationMs).toBeGreaterThanOrEqual(400)
    expect(engine.running()).toBe(false)
    expect(sup().stops).toBe(1)
    expect(sup().kills).toBe(0)
  })

  it('a run that never settles ends on the backstop with reason budget', () => {
    const graph = graphOf(50)
    const onCool = vi.fn()
    const { factory } = fakeSupervisor(() => 30)
    const engine = createLayoutEngine(graph, { onCool, minRunMs: 400, maxRunMs: 3000, createSupervisor: factory })
    engine.run('initial')
    vi.advanceTimersByTime(2999)
    expect(onCool).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onCool.mock.calls[0][0].reason).toBe('budget')
  })

  it('a second run resumes the same paused worker from the current positions', () => {
    const graph = graphOf(20)
    const onCool = vi.fn()
    const { factory, sup } = fakeSupervisor(() => 0.001)
    const engine = createLayoutEngine(graph, { onCool, minRunMs: 100, createSupervisor: factory })
    engine.run('initial')
    vi.advanceTimersByTime(1000)
    expect(onCool).toHaveBeenCalledTimes(1)
    const xAfterFirst = graph.getNodeAttribute('n0', 'x') as number

    engine.run('drop')
    expect(sup().starts).toBe(2)
    vi.advanceTimersByTime(1000)
    expect(onCool).toHaveBeenCalledTimes(2)
    expect(onCool.mock.calls[1][0].runReason).toBe('drop')
    // Continued from where it was, not from the seed.
    expect(graph.getNodeAttribute('n0', 'x') as number).toBeGreaterThan(xAfterFirst)
  })

  it('reheating a running run resets convergence instead of restarting the worker', () => {
    const graph = graphOf(20)
    const onCool = vi.fn()
    const { factory, sup } = fakeSupervisor(() => 0.001)
    const engine = createLayoutEngine(graph, { onCool, minRunMs: 100, createSupervisor: factory })
    engine.run('initial')
    vi.advanceTimersByTime(70) // a few still ticks, not yet patience
    engine.run('drag')
    expect(sup().starts).toBe(1)
    expect(onCool).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(onCool).toHaveBeenCalledTimes(1)
  })

  it('a held node is restored to the cursor on every write-back and released on hold(null)', () => {
    const graph = graphOf(5)
    const { factory } = fakeSupervisor(() => 30)
    const engine = createLayoutEngine(graph, { onCool: vi.fn(), createSupervisor: factory })
    engine.run('drag')
    engine.hold('n0', { x: 500, y: 600 })
    vi.advanceTimersByTime(100)
    expect(graph.getNodeAttribute('n0', 'x')).toBe(500)
    expect(graph.getNodeAttribute('n0', 'y')).toBe(600)
    // Unheld nodes moved.
    expect(graph.getNodeAttribute('n1', 'x') as number).toBeGreaterThan(100)

    engine.hold(null)
    vi.advanceTimersByTime(50)
    expect(graph.getNodeAttribute('n0', 'x') as number).toBeGreaterThan(500)
  })

  it('a run paces the worker by reason, and a reheat re-paces without restarting', () => {
    const graph = graphOf(5)
    const { factory, sup } = fakeSupervisor(() => 30)
    const engine = createLayoutEngine(graph, { onCool: vi.fn(), createSupervisor: factory })
    engine.run('initial')
    expect(sup().iterations).toBe(ITERATIONS_BY_REASON.initial)
    engine.run('drag')
    expect(sup().iterations).toBe(ITERATIONS_BY_REASON.drag)
    expect(sup().starts).toBe(1)
    expect(sup().stops).toBe(0)
    expect(engine.running()).toBe(true)
  })

  it('a confined run holds every node outside the free set and releases them to their pinned state when it cools', () => {
    const graph = graphOf(6)
    const onCool = vi.fn()
    const { factory } = fakeSupervisor(() => 0)
    const engine = createLayoutEngine(graph, { onCool, createSupervisor: factory, minRunMs: 0 })
    engine.run('drop', { free: new Set(['n1', 'n2']), pinned: new Set(['n5']) })
    expect(graph.getNodeAttribute('n0', 'fixed')).toBe(true)
    expect(graph.getNodeAttribute('n1', 'fixed')).toBe(false)
    expect(graph.getNodeAttribute('n5', 'fixed')).toBe(true)
    vi.advanceTimersByTime(16 * (CONVERGENCE_PATIENCE + 1) + MIN_RUN_MS)
    expect(onCool).toHaveBeenCalledTimes(1)
    expect(graph.getNodeAttribute('n0', 'fixed')).toBe(false)
    expect(graph.getNodeAttribute('n5', 'fixed')).toBe(true)
  })

  it('a confined run converges on its free nodes, not on the held remainder', () => {
    const graph = graphOf(6)
    const onCool = vi.fn()
    // Every free node keeps moving; the held ones cannot. Judged over all
    // six the mean would fall under the threshold; over the free two it
    // never does, so the run must reach the backstop.
    const { factory } = fakeSupervisor(() => 30)
    const engine = createLayoutEngine(graph, { onCool, createSupervisor: factory, minRunMs: 0, maxRunMs: 500 })
    engine.run('drop', { free: new Set(['n1', 'n2']), pinned: new Set() })
    vi.advanceTimersByTime(400)
    expect(onCool).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onCool).toHaveBeenCalledWith(expect.objectContaining({ reason: 'budget' }))
  })

  it('a new unconfined drag on a settling region frees everything but the held node', () => {
    const graph = graphOf(4)
    const { factory } = fakeSupervisor(() => 30)
    const engine = createLayoutEngine(graph, { onCool: vi.fn(), createSupervisor: factory })
    engine.run('drop', { free: new Set(['n1']), pinned: new Set(['n3']) })
    expect(graph.getNodeAttribute('n0', 'fixed')).toBe(true)
    graph.setNodeAttribute('n2', 'fixed', true)
    engine.hold('n2', { x: 0, y: 0 })
    engine.run('drag')
    expect(graph.getNodeAttribute('n0', 'fixed')).toBe(false)
    expect(graph.getNodeAttribute('n2', 'fixed')).toBe(true)
    expect(graph.getNodeAttribute('n3', 'fixed')).toBe(true)
  })

  it('kill() stops and kills the worker and never fires onCool', () => {
    const graph = graphOf(20)
    const onCool = vi.fn()
    const { factory, sup } = fakeSupervisor(() => 0.001)
    const engine = createLayoutEngine(graph, { onCool, createSupervisor: factory })
    engine.run('initial')
    vi.advanceTimersByTime(100)
    engine.kill()
    const ticksAtKill = sup().ticks
    vi.advanceTimersByTime(30000)
    expect(sup().ticks).toBe(ticksAtKill)
    expect(sup().kills).toBe(1)
    expect(onCool).not.toHaveBeenCalled()
    expect(engine.running()).toBe(false)
  })

  it('an empty graph cools immediately as converged', () => {
    const onCool = vi.fn()
    createLayoutEngine(new Graph(), { onCool }).run('initial')
    expect(onCool).toHaveBeenCalledWith(expect.objectContaining({ reason: 'converged', runReason: 'initial', ticks: 0, finalDisplacement: 0, durationMs: 0, freeCount: 0 }))
  })
})
