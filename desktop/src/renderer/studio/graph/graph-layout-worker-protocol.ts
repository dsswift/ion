/** Messages between the layout supervisor and its worker. Kept free of imports so both sides can share it. */

export interface LayoutWorkerRequest {
  /** Which matrix build this belongs to; replies from an older build are discarded. */
  generation: number
  settings: Record<string, unknown>
  /** Iterations to run before replying. More per round trip is a stronger pull per frame at the same write-back cost. */
  iterations: number
  nodes: ArrayBuffer
  /** Present on the first request of a generation only. */
  edges?: ArrayBuffer
}

export interface LayoutWorkerReply {
  generation: number
  nodes: ArrayBuffer
}
