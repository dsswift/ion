/**
 * The force layout's worker: one ForceAtlas2 iteration per message.
 *
 * Every request carries a `generation`, and the reply echoes it. The
 * supervisor bumps the generation each time it rebuilds the matrices, so a
 * reply from a matrix that has since been replaced can be recognised and
 * dropped instead of feeding a second, interleaved simulation.
 *
 * The edge matrix travels only with the first request of a generation; the
 * worker keeps it between iterations. Node positions round-trip on every
 * message, transferred rather than copied.
 */

import iterate from 'graphology-layout-forceatlas2/iterate'
import type { LayoutWorkerReply, LayoutWorkerRequest } from './graph-layout-worker-protocol'

/** The dedicated-worker scope, typed to what this file uses; the renderer's `dom` lib types `self` as a window. */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<LayoutWorkerRequest>) => void): void
  postMessage(message: LayoutWorkerReply, transfer: Transferable[]): void
}
const scope = self as unknown as WorkerScope

let edges = new Float32Array(0)

scope.addEventListener('message', (event) => {
  const { generation, settings, iterations, nodes: nodesBuffer } = event.data
  const nodes = new Float32Array(nodesBuffer)
  if (event.data.edges) edges = new Float32Array(event.data.edges)
  for (let i = 0; i < Math.max(1, iterations); i++) iterate(settings, nodes, edges)
  const buffer = nodes.buffer as ArrayBuffer
  scope.postMessage({ generation, nodes: buffer }, [buffer])
})
