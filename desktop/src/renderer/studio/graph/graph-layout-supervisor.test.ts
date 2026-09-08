/**
 * Pins the one property the stock ForceAtlas2 supervisor lacks: a reply
 * from a matrix that has been replaced is dropped, so a stop/start mid-run
 * never leaves two simulations writing the graph on alternate ticks.
 */
import { describe, expect, it, vi } from 'vitest'
import Graph from 'graphology'
import { createLayoutSupervisor, type LayoutWorkerLike } from './graph-layout-supervisor'
import type { LayoutWorkerReply, LayoutWorkerRequest } from './graph-layout-worker-protocol'

/** A worker whose replies are delivered by hand, so a reply can be held in flight across a restart. */
function fakeWorker(): LayoutWorkerLike & { requests: LayoutWorkerRequest[]; reply(request: LayoutWorkerRequest, shift?: number): void; terminated: boolean } {
  let listener: ((event: MessageEvent<LayoutWorkerReply>) => void) | null = null
  const requests: LayoutWorkerRequest[] = []
  return {
    requests,
    terminated: false,
    postMessage(message) {
      // Simulate the transfer: the caller's buffer is detached, the worker
      // gets a copy it owns.
      requests.push({ ...message, nodes: message.nodes.slice(0) })
    },
    addEventListener(_type, fn) {
      listener = fn
    },
    removeEventListener() {
      listener = null
    },
    terminate() {
      this.terminated = true
    },
    reply(request, shift = 1) {
      const nodes = new Float32Array(request.nodes)
      for (let i = 0; i < nodes.length; i += 10) {
        nodes[i] += shift
        nodes[i + 1] += shift
      }
      listener?.({ data: { generation: request.generation, nodes: nodes.buffer } } as MessageEvent<LayoutWorkerReply>)
    },
  }
}

function graphOf(): Graph {
  const g = new Graph()
  g.addNode('a', { x: 0, y: 0, size: 3 })
  g.addNode('b', { x: 10, y: 10, size: 3 })
  g.addEdge('a', 'b')
  return g
}

describe('createLayoutSupervisor', () => {
  it('a reply writes positions to the graph and asks for the next iteration', () => {
    const worker = fakeWorker()
    const graph = graphOf()
    const sup = createLayoutSupervisor(graph, { settings: {}, createWorker: () => worker })
    sup.start()
    expect(worker.requests).toHaveLength(1)
    expect(worker.requests[0].edges).toBeDefined()
    worker.reply(worker.requests[0])
    expect(graph.getNodeAttribute('a', 'x')).toBe(1)
    expect(worker.requests).toHaveLength(2)
    expect(worker.requests[1].edges).toBeUndefined()
  })

  it('a reply from before a restart is dropped, so only one loop survives', () => {
    const worker = fakeWorker()
    const graph = graphOf()
    const onStaleReply = vi.fn()
    const sup = createLayoutSupervisor(graph, { settings: {}, createWorker: () => worker, onStaleReply })
    sup.start()
    const inFlight = worker.requests[0]
    // The restart the engine performs for a fixed-flag change, with the
    // first request still with the worker.
    sup.stop()
    sup.start()
    expect(worker.requests).toHaveLength(2)
    expect(sup.generation()).toBe(2)

    worker.reply(inFlight, 100)
    expect(graph.getNodeAttribute('a', 'x')).toBe(0)
    expect(worker.requests).toHaveLength(2)
    expect(onStaleReply).toHaveBeenCalledWith(expect.objectContaining({ replyGeneration: 1, currentGeneration: 2, droppedSoFar: 1 }))

    worker.reply(worker.requests[1])
    expect(graph.getNodeAttribute('a', 'x')).toBe(1)
    expect(worker.requests).toHaveLength(3)
  })

  it('a reply after stop is dropped and does not restart the loop', () => {
    const worker = fakeWorker()
    const sup = createLayoutSupervisor(graphOf(), { settings: {}, createWorker: () => worker })
    sup.start()
    sup.stop()
    worker.reply(worker.requests[0])
    expect(worker.requests).toHaveLength(1)
    expect(sup.isRunning()).toBe(false)
  })

  it('the output reducer can hold a node in place and the worker sees the held position', () => {
    const worker = fakeWorker()
    const graph = graphOf()
    const sup = createLayoutSupervisor(graph, {
      settings: {},
      createWorker: () => worker,
      outputReducer: (key, attrs) => (key === 'a' ? { ...attrs, x: 42, y: 42 } : attrs),
    })
    sup.start()
    worker.reply(worker.requests[0])
    expect(graph.getNodeAttribute('a', 'x')).toBe(42)
    expect(new Float32Array(worker.requests[1].nodes)[0]).toBe(42)
  })

  it('a fixed flag set mid-run reaches the worker on the next write-back, with no restart', () => {
    const worker = fakeWorker()
    const graph = graphOf()
    const sup = createLayoutSupervisor(graph, { settings: {}, createWorker: () => worker })
    sup.start()
    graph.setNodeAttribute('a', 'fixed', true)
    worker.reply(worker.requests[0])
    const sent = new Float32Array(worker.requests[1].nodes)
    expect(sent[9]).toBe(1)
    expect(sent[19]).toBe(0)
    expect(sup.generation()).toBe(1)
    graph.setNodeAttribute('a', 'fixed', false)
    worker.reply(worker.requests[1])
    expect(new Float32Array(worker.requests[2].nodes)[9]).toBe(0)
  })

  it('iterations per round trip change on the next request without a restart', () => {
    const worker = fakeWorker()
    const sup = createLayoutSupervisor(graphOf(), { settings: {}, createWorker: () => worker })
    sup.start()
    expect(worker.requests[0].iterations).toBe(1)
    sup.setIterations(3)
    worker.reply(worker.requests[0])
    expect(worker.requests[1].iterations).toBe(3)
    expect(sup.generation()).toBe(1)
  })

  it('a structural change mid-run rebuilds under a new generation', () => {
    const worker = fakeWorker()
    const graph = graphOf()
    const sup = createLayoutSupervisor(graph, { settings: {}, createWorker: () => worker })
    sup.start()
    graph.addNode('c', { x: 5, y: 5, size: 3 })
    expect(sup.generation()).toBe(2)
    expect(sup.isRunning()).toBe(true)
    expect(new Float32Array(worker.requests[1].nodes).length).toBe(3 * 10)
  })

  it('kill terminates the worker and ignores anything after', () => {
    const worker = fakeWorker()
    const graph = graphOf()
    const sup = createLayoutSupervisor(graph, { settings: {}, createWorker: () => worker })
    sup.start()
    const request = worker.requests[0]
    sup.kill()
    expect(worker.terminated).toBe(true)
    worker.reply(request)
    expect(graph.getNodeAttribute('a', 'x')).toBe(0)
    expect(() => sup.start()).toThrow()
  })
})
