/**
 * Pins the convergence criterion: the layout is settled when the graph's
 * normalized movement stays below the threshold for `patience` consecutive
 * ticks — not before, and not on a stopwatch.
 */
import { describe, expect, it, vi } from 'vitest'
import Graph from 'graphology'
import { createConvergenceMonitor } from './graph-layout-convergence'

function grid(n: number): Graph {
  const graph = new Graph()
  for (let i = 0; i < n; i++) graph.addNode(`n${i}`, { x: (i % 10) * 100, y: Math.floor(i / 10) * 100 })
  return graph
}

/** Move every node by `step` and emit the tick the FA2 supervisor would. */
function tick(graph: Graph, step: number): void {
  graph.updateEachNodeAttributes((_id, attrs) => ({ ...attrs, x: (attrs.x as number) + step, y: (attrs.y as number) + step }))
}

describe('createConvergenceMonitor', () => {
  it('converges after exactly `patience` consecutive still ticks', () => {
    const graph = grid(50)
    const onConverged = vi.fn()
    createConvergenceMonitor(graph, { threshold: 0.001, patience: 4, onConverged })

    // Bounding-box diagonal is ~ 1272 units; a step of 0.1 is ~0.00008 normalized.
    tick(graph, 0.1)
    tick(graph, 0.1)
    tick(graph, 0.1)
    expect(onConverged).not.toHaveBeenCalled()
    tick(graph, 0.1)
    expect(onConverged).toHaveBeenCalledTimes(1)
    expect(onConverged.mock.calls[0][0]).toMatchObject({ ticks: 4 })
    expect(onConverged.mock.calls[0][0].displacement).toBeLessThan(0.001)
  })

  it('a large move resets the still run', () => {
    const graph = grid(50)
    const onConverged = vi.fn()
    createConvergenceMonitor(graph, { threshold: 0.001, patience: 3, onConverged })

    tick(graph, 0.1)
    tick(graph, 0.1)
    tick(graph, 50) // ~0.04 normalized: not still
    tick(graph, 0.1)
    tick(graph, 0.1)
    expect(onConverged).not.toHaveBeenCalled()
    tick(graph, 0.1)
    expect(onConverged).toHaveBeenCalledTimes(1)
    expect(onConverged.mock.calls[0][0]).toMatchObject({ ticks: 6 })
  })

  it('constant motion never converges', () => {
    const graph = grid(50)
    const onConverged = vi.fn()
    const monitor = createConvergenceMonitor(graph, { threshold: 0.001, patience: 3, onConverged })
    for (let i = 0; i < 100; i++) tick(graph, 20)
    expect(onConverged).not.toHaveBeenCalled()
    expect(monitor.last()?.ticks).toBe(100)
  })

  it('normalizes by the bounding box, so the same relative motion converges at any scale', () => {
    const small = grid(50)
    const large = grid(50)
    large.updateEachNodeAttributes((_id, a) => ({ ...a, x: (a.x as number) * 100, y: (a.y as number) * 100 }))
    const smallHit = vi.fn()
    const largeHit = vi.fn()
    createConvergenceMonitor(small, { threshold: 0.001, patience: 2, onConverged: smallHit })
    createConvergenceMonitor(large, { threshold: 0.001, patience: 2, onConverged: largeHit })

    tick(small, 0.1)
    tick(small, 0.1)
    tick(large, 10)
    tick(large, 10)
    expect(smallHit).toHaveBeenCalledTimes(1)
    expect(largeHit).toHaveBeenCalledTimes(1)
  })

  it('reset() forgets the still run so a disturbance has to settle again', () => {
    const graph = grid(50)
    const onConverged = vi.fn()
    const monitor = createConvergenceMonitor(graph, { threshold: 0.001, patience: 3, onConverged })
    tick(graph, 0.1)
    tick(graph, 0.1)
    monitor.reset()
    tick(graph, 0.1)
    tick(graph, 0.1)
    expect(onConverged).not.toHaveBeenCalled()
    tick(graph, 0.1)
    expect(onConverged).toHaveBeenCalledTimes(1)
  })

  it('stops observing after convergence and after dispose', () => {
    const graph = grid(10)
    const onConverged = vi.fn()
    const monitor = createConvergenceMonitor(graph, { threshold: 0.001, patience: 1, onConverged })
    tick(graph, 0.01)
    expect(onConverged).toHaveBeenCalledTimes(1)
    tick(graph, 0.01)
    expect(onConverged).toHaveBeenCalledTimes(1)
    expect(monitor.last()?.ticks).toBe(1)

    const second = createConvergenceMonitor(graph, { threshold: 0.001, patience: 1, onConverged: vi.fn() })
    second.dispose()
    tick(graph, 0.01)
    expect(second.last()).toBeNull()
  })
})
