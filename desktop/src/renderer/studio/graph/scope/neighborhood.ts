/**
 * Neighborhood scope: a breadth-first expansion to `depth` hops. By default
 * direction is ignored — a document superseded by the anchor is part of its
 * neighborhood exactly as much as one it supersedes, because scope is a
 * navigation aid, not a directed-graph traversal.
 *
 * A direction can be asked for. Every edge has a stored source and target
 * even when it is undirected: a wikilink from A to B is stored A→B, so
 * "outgoing" from A reaches B and "incoming" to B reaches A. That is the
 * reading direction an operator means by "what does this link to" and
 * "what links here", and it is meaningful on every edge origin, not only
 * the two structurally directed supersession fields.
 */

import type Graph from 'graphology'

/** Which way a hop may travel: along stored edge direction, against it, or either. */
export type NeighborhoodDirection = 'out' | 'in' | 'both'

/** The nodes one hop from `id` in `direction`. */
export function neighborsInDirection(graph: Graph, id: string, direction: NeighborhoodDirection): string[] {
  if (direction === 'both') return graph.neighbors(id)
  const out: string[] = []
  graph.forEachEdge(id, (_edge, _attrs, source, target) => {
    if (direction === 'out' && source === id) out.push(target)
    else if (direction === 'in' && target === id) out.push(source)
  })
  return out
}

/** BFS neighborhood of `anchorId` to `depth` hops, including the anchor. Missing anchor returns empty. */
export function neighborhood(graph: Graph, anchorId: string, depth: number, direction: NeighborhoodDirection = 'both'): Set<string> {
  if (!graph.hasNode(anchorId)) return new Set()

  const visited = new Set<string>([anchorId])
  let frontier = [anchorId]

  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbor of neighborsInDirection(graph, id, direction)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          next.push(neighbor)
        }
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }

  return visited
}
