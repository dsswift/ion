/**
 * The supervisor reports what each round trip cost, counts stale replies
 * per generation, and reads its settings fresh per request.
 */
import { describe, expect, it, vi } from 'vitest'
import Graph from 'graphology'
import { createLayoutSupervisor, type LayoutWorkerLike } from './graph-layout-supervisor'
import type { LayoutWorkerReply, LayoutWorkerRequest } from './graph-layout-worker-protocol'

function fakeWorker(): LayoutWorkerLike & { requests: LayoutWorkerRequest[]; reply(generation: number): void } {
  const listeners = new Set<(event: MessageEvent<LayoutWorkerReply>) => void>()
  const requests: LayoutWorkerRequest[] = []
  return {
    requests,
    postMessage(message) {
      requests.push(message)
    },
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    },
    terminate() {},
    reply(generation) {
      const last = requests[requests.length - 1]
      const nodes = new Float32Array(new ArrayBuffer(last.nodes.byteLength))
      for (const l of listeners) l({ data: { generation, nodes: nodes.buffer as ArrayBuffer } } as MessageEvent<LayoutWorkerReply>)
    },
  }
}

function graph(): Graph {
  const g = new Graph()
  g.addNode('a', { x: 0, y: 0 })
  g.addNode('b', { x: 1, y: 1 })
  g.addEdge('a', 'b')
  return g
}

describe('createLayoutSupervisor', () => {
  it('reports round-trip and write-back timing for every reply written back', () => {
    const worker = fakeWorker()
    const ticks: { roundTripMs: number; writeBackMs: number }[] = []
    const supervisor = createLayoutSupervisor(graph(), { settings: {}, createWorker: () => worker, onTick: (t) => ticks.push(t) })
    supervisor.start()
    worker.reply(1)
    worker.reply(1)
    expect(ticks).toHaveLength(2)
    for (const t of ticks) {
      expect(t.roundTripMs).toBeGreaterThanOrEqual(0)
      expect(t.writeBackMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('counts stale replies per generation, resetting on every start', () => {
    const worker = fakeWorker()
    const stale: { droppedSoFar: number; droppedSinceStart: number }[] = []
    const supervisor = createLayoutSupervisor(graph(), { settings: {}, createWorker: () => worker, onStaleReply: (i) => stale.push({ droppedSoFar: i.droppedSoFar, droppedSinceStart: i.droppedSinceStart }) })
    supervisor.start()
    supervisor.stop()
    supervisor.start()
    worker.reply(1) // from the first matrix: one expected stale drop
    supervisor.stop()
    supervisor.start()
    worker.reply(2)
    expect(stale).toEqual([
      { droppedSoFar: 1, droppedSinceStart: 1 },
      { droppedSoFar: 2, droppedSinceStart: 1 },
    ])
  })

  it('reads the settings object fresh on every request, so a force change needs no restart', () => {
    const worker = fakeWorker()
    const settings: Record<string, unknown> = { gravity: 0.05 }
    const supervisor = createLayoutSupervisor(graph(), { settings, createWorker: () => worker })
    supervisor.start()
    expect(worker.requests[0].settings.gravity).toBe(0.05)
    settings.gravity = 0.5
    worker.reply(1)
    expect(worker.requests[1].settings.gravity).toBe(0.5)
    void vi
  })
})
