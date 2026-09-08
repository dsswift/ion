/**
 * Tests for neighborhood.ts (child 07): depth 1, 2, 3 over a known graph,
 * direction ignored, and a missing anchor returns empty.
 */
import { describe, expect, it } from 'vitest'
import Graph from 'graphology'
import { neighborhood, neighborsInDirection } from './neighborhood'

function chainGraph(): Graph {
  const graph = new Graph({ multi: true, type: 'mixed' })
  for (const id of ['a', 'b', 'c', 'd', 'e']) graph.addNode(id)
  graph.addUndirectedEdge('a', 'b')
  graph.addUndirectedEdge('b', 'c')
  graph.addUndirectedEdge('c', 'd')
  graph.addUndirectedEdge('d', 'e')
  return graph
}

describe('neighborhood', () => {
  it('depth 1 includes the anchor and its immediate neighbor', () => {
    const graph = chainGraph()
    expect(neighborhood(graph, 'a', 1)).toEqual(new Set(['a', 'b']))
  })

  it('depth 2 expands two hops', () => {
    const graph = chainGraph()
    expect(neighborhood(graph, 'a', 2)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('depth 3 expands three hops', () => {
    const graph = chainGraph()
    expect(neighborhood(graph, 'a', 3)).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('a directed edge is traversed regardless of direction', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    graph.addNode('a')
    graph.addNode('b')
    graph.addDirectedEdge('b', 'a') // b -> a, so 'a' is the TARGET
    expect(neighborhood(graph, 'a', 1)).toEqual(new Set(['a', 'b']))
  })

  it('a missing anchor returns an empty set', () => {
    const graph = chainGraph()
    expect(neighborhood(graph, 'ghost', 2)).toEqual(new Set())
  })

  it('an isolated anchor at any depth returns just itself', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    graph.addNode('lonely')
    expect(neighborhood(graph, 'lonely', 5)).toEqual(new Set(['lonely']))
  })
})

describe('neighborhood — direction', () => {
  it('out follows stored source→target, in follows the reverse, on undirected edges too', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    for (const id of ['a', 'b', 'c']) graph.addNode(id)
    graph.addUndirectedEdge('a', 'b') // a links to b
    graph.addDirectedEdge('c', 'b') // c supersedes b
    expect([...neighborsInDirection(graph, 'b', 'out')]).toEqual([])
    expect([...neighborsInDirection(graph, 'b', 'in')].sort()).toEqual(['a', 'c'])
    expect(neighborhood(graph, 'a', 2, 'out')).toEqual(new Set(['a', 'b']))
    expect(neighborhood(graph, 'a', 2, 'in')).toEqual(new Set(['a']))
    expect(neighborhood(graph, 'a', 2, 'both')).toEqual(new Set(['a', 'b', 'c']))
  })
})
