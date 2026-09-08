declare module '*.mp3' {
  const src: string
  export default src
}

// Electron <webview> tag (Studio browser surface only; the tag is enabled
// solely on the Studio window and hardened by main/webview-policy.ts).
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: string
      },
      HTMLElement
    >
  }
}

// graphology-layout-forceatlas2 ships types for its top-level entry and its
// worker supervisor only. The graph stage drives the algorithm through its
// own supervisor (studio/graph/graph-layout-supervisor.ts), which needs the
// untyped internals: the per-tick iteration and the matrix helpers.
declare module 'graphology-layout-forceatlas2/iterate' {
  const iterate: (settings: Record<string, unknown>, nodes: Float32Array, edges: Float32Array) => Record<string, unknown>
  export default iterate
}

declare module 'graphology-layout-forceatlas2/defaults' {
  const defaults: Record<string, unknown>
  export default defaults
}

declare module 'graphology-layout-forceatlas2/helpers' {
  import type Graph from 'graphology'
  import type { Attributes } from 'graphology-types'
  export function graphToByteArrays(
    graph: Graph,
    getEdgeWeight: (edge: string, attributes: Attributes, source: string, target: string, sourceAttributes: Attributes, targetAttributes: Attributes, undirected: boolean) => number,
  ): { nodes: Float32Array; edges: Float32Array }
  export function assignLayoutChanges(graph: Graph, nodes: Float32Array, outputReducer: ((key: string, attributes: Attributes) => Attributes) | null): void
  export function readGraphPositions(graph: Graph, nodes: Float32Array): void
}
