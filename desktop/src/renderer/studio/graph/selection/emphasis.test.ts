import { describe, expect, it } from 'vitest'
import Graph from 'graphology'
import { computeEmphasis } from './emphasis'

/** a — b — c — d, plus an isolated e. */
function chain(): Graph {
  const g = new Graph()
  for (const id of ['a', 'b', 'c', 'd', 'e']) g.addNode(id)
  g.addEdge('a', 'b')
  g.addEdge('b', 'c')
  g.addEdge('c', 'd')
  return g
}

describe('computeEmphasis', () => {
  it('is empty with no selection', () => {
    expect(computeEmphasis(chain(), new Set())).toEqual(new Set())
  })

  it('is the selected node plus its 1-hop neighbours', () => {
    expect(computeEmphasis(chain(), new Set(['b']))).toEqual(new Set(['a', 'b', 'c']))
  })

  it('is the union across a multi-selection', () => {
    expect(computeEmphasis(chain(), new Set(['a', 'd']))).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('keeps a selected id that is no longer in the graph', () => {
    expect(computeEmphasis(chain(), new Set(['ghost']))).toEqual(new Set(['ghost']))
  })

  it('is empty without a graph', () => {
    expect(computeEmphasis(null, new Set(['a']))).toEqual(new Set())
  })
})
