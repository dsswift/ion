/**
 * The layout supervisor: drives one ForceAtlas2 worker over one graphology
 * instance, one iteration per round trip, writing every reply's positions
 * back onto the graph.
 *
 * This replaces the library's own worker supervisor for one reason. That
 * supervisor accepts any reply while it is running, and exactly one
 * request is always in flight while it runs. Stopping and starting it
 * (which is how a mid-run change to a node's `fixed` flag reaches the
 * worker) therefore leaves the old reply in flight; when it lands, the
 * supervisor writes it to the graph and asks for another iteration on it,
 * and from then on TWO position matrices take turns being written to the
 * graph on alternate ticks. The picture judders between two simulations,
 * the convergence monitor never sees a still tick, and every further
 * restart adds another loop. That is the bounce after a drop.
 *
 * Here every request carries a generation and the worker echoes it; a
 * reply from any generation but the current one is dropped and counted.
 * A restart is then safe at any moment, and a structural change to the
 * graph (a node or edge added or dropped) is handled the same way — a
 * rebuild under a new generation — instead of by respawning the worker.
 *
 * A restart is also RARE. Rebuilding the matrix zeroes every node's
 * velocity and resets its adaptive speed, which re-agitates the whole
 * graph — a drop that only disturbed one neighbourhood then takes the
 * whole corpus seconds to calm again. So the one thing that used to need a
 * restart mid-run, a node's `fixed` flag changing, is instead read from
 * the graph on every write-back and written into the matrix before it goes
 * back to the worker. The worker always sees the current flags, and the
 * simulation keeps its momentum across a drag and a drop.
 */

import type Graph from 'graphology'
import type { Attributes } from 'graphology-types'
import DEFAULT_SETTINGS from 'graphology-layout-forceatlas2/defaults'
import { assignLayoutChanges, graphToByteArrays, readGraphPositions } from 'graphology-layout-forceatlas2/helpers'
import type { LayoutWorkerReply, LayoutWorkerRequest } from './graph-layout-worker-protocol'

/** The slice of `Worker` the supervisor uses, so a test can stand in a fake. */
export interface LayoutWorkerLike {
  postMessage(message: LayoutWorkerRequest, transfer: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<LayoutWorkerReply>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<LayoutWorkerReply>) => void): void
  terminate(): void
}

export type LayoutOutputReducer = (key: string, attributes: Attributes) => Attributes

export interface StaleReplyInfo {
  /** The generation the reply belonged to. */
  replyGeneration: number
  /** The generation in force when it arrived. */
  currentGeneration: number
  running: boolean
  /** Stale replies dropped so far on this supervisor, across every restart. */
  droppedSoFar: number
  /**
   * Stale replies dropped since the current generation started. One is the
   * expected shape of a restart (the reply already in flight lands after the
   * new matrix went out); more than one in a single generation means replies
   * are arriving from more than one superseded matrix, which is the storm.
   */
  droppedSinceStart: number
}

/** How one round trip through the worker cost the main thread, for the engine's per-run summary. */
export interface LayoutTickTiming {
  /** From posting a request to its reply arriving: the worker's iterations plus message transit. */
  roundTripMs: number
  /** Time spent writing the reply back onto the graph and rebuilding the matrix for the next request. */
  writeBackMs: number
}

export interface LayoutSupervisorOptions {
  settings: Record<string, unknown>
  /** Applied to every node on every write-back; may return replacement attributes. */
  outputReducer?: LayoutOutputReducer
  /** Test seam: the worker to drive. Defaults to the module worker beside this file. */
  createWorker?: () => LayoutWorkerLike
  /** Fired each time a reply is dropped for belonging to a superseded matrix. */
  onStaleReply?: (info: StaleReplyInfo) => void
  /** Fired for every reply written back, with what it cost. */
  onTick?: (timing: LayoutTickTiming) => void
}

export interface LayoutSupervisor {
  start(): void
  stop(): void
  kill(): void
  isRunning(): boolean
  /** Iterations per round trip from the next request on. Takes effect without a restart. */
  setIterations(count: number): void
  /** The current matrix generation; bumps on every start. */
  generation(): number
}

/** Floats per node in the ForceAtlas2 matrix, and the slot the fixed flag lives in. */
const FLOATS_PER_NODE = 10
const FIXED_SLOT = 9

/** Write every node's current `fixed` flag into the matrix, in the graph's node order (the order the matrix was built in). */
export function readGraphFixedFlags(graph: Graph, matrix: Float32Array): void {
  let i = FIXED_SLOT
  graph.forEachNode((_id, attrs) => {
    matrix[i] = attrs.fixed === true ? 1 : 0
    i += FLOATS_PER_NODE
  })
}

function defaultCreateWorker(): LayoutWorkerLike {
  return new Worker(new URL('./graph-layout.worker.ts', import.meta.url), { type: 'module' })
}

function edgeWeight(_edge: string, attributes: Attributes): number {
  const weight = attributes.weight
  return typeof weight === 'number' && Number.isFinite(weight) ? weight : 1
}

export function createLayoutSupervisor(graph: Graph, options: LayoutSupervisorOptions): LayoutSupervisor {
  // The caller's settings object is read on every request rather than
  // copied once, so a force parameter the operator changes mid-run reaches
  // the worker on the next round trip without a restart.
  const settings = (): Record<string, unknown> => ({ ...DEFAULT_SETTINGS, ...options.settings })
  const outputReducer = options.outputReducer ?? null
  const worker = (options.createWorker ?? defaultCreateWorker)()

  let running = false
  let killed = false
  let generation = 0
  let staleDropped = 0
  let staleDroppedSinceStart = 0
  let iterations = 1
  let postedAt = 0

  const post = (message: LayoutWorkerRequest, transfer: Transferable[]): void => {
    postedAt = performance.now()
    worker.postMessage(message, transfer)
  }

  const onMessage = (event: MessageEvent<LayoutWorkerReply>): void => {
    if (killed) return
    const reply = event.data
    if (!running || reply.generation !== generation) {
      staleDropped++
      staleDroppedSinceStart++
      options.onStaleReply?.({ replyGeneration: reply.generation, currentGeneration: generation, running, droppedSoFar: staleDropped, droppedSinceStart: staleDroppedSinceStart })
      return
    }
    const arrivedAt = performance.now()
    const matrix = new Float32Array(reply.nodes)
    assignLayoutChanges(graph, matrix, outputReducer)
    // The reducer may have moved a node (a held node back to the cursor);
    // the worker must see the graph as it is, not as it computed it.
    if (outputReducer) readGraphPositions(graph, matrix)
    readGraphFixedFlags(graph, matrix)
    const buffer = matrix.buffer as ArrayBuffer
    options.onTick?.({ roundTripMs: arrivedAt - postedAt, writeBackMs: performance.now() - arrivedAt })
    post({ generation, settings: settings(), iterations, nodes: buffer }, [buffer])
  }
  worker.addEventListener('message', onMessage)

  const start = (): void => {
    if (killed) throw new Error('graph layout supervisor: start after kill')
    if (running) return
    const matrices = graphToByteArrays(graph, edgeWeight)
    generation++
    staleDroppedSinceStart = 0
    running = true
    const nodeBuffer = matrices.nodes.buffer as ArrayBuffer
    const edgeBuffer = matrices.edges.buffer as ArrayBuffer
    post({ generation, settings: settings(), iterations, nodes: nodeBuffer, edges: edgeBuffer }, [nodeBuffer, edgeBuffer])
  }

  const stop = (): void => {
    running = false
  }

  // A node or edge added or dropped changes the matrix layout; the reply in
  // flight describes a graph that no longer exists. Rebuild under a new
  // generation; the stale reply is dropped when it lands.
  const onStructureChanged = (): void => {
    if (!running) return
    stop()
    start()
  }
  graph.on('nodeAdded', onStructureChanged)
  graph.on('edgeAdded', onStructureChanged)
  graph.on('nodeDropped', onStructureChanged)
  graph.on('edgeDropped', onStructureChanged)

  return {
    start,
    stop,
    kill() {
      if (killed) return
      killed = true
      running = false
      graph.off('nodeAdded', onStructureChanged)
      graph.off('edgeAdded', onStructureChanged)
      graph.off('nodeDropped', onStructureChanged)
      graph.off('edgeDropped', onStructureChanged)
      worker.removeEventListener('message', onMessage)
      worker.terminate()
    },
    isRunning: () => running,
    setIterations(count) {
      iterations = Math.max(1, Math.floor(count))
    },
    generation: () => generation,
  }
}
