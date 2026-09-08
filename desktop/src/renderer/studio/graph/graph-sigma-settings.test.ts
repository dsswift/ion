import { describe, expect, it, vi } from 'vitest'

vi.mock('sigma/rendering', () => ({ NodePointProgram: class {}, NodeProgram: class {}, EdgeRectangleProgram: class {}, EdgeArrowProgram: class {} }))
vi.mock('sigma/utils', () => ({ floatColor: () => 0 }))
vi.mock('@sigma/node-border', () => ({ NodeBorderProgram: class {}, createNodeBorderProgram: () => class {} }))
vi.mock('@sigma/edge-curve', () => ({ default: class {}, EdgeCurvedArrowProgram: class {} }))

import Graph from 'graphology'
import { createSigmaSettings, HIDE_EDGES_ON_MOVE_ABOVE } from './graph-sigma-settings'
import { darkColors } from '../../theme/palette-dark'

function graphWithEdges(count: number): Graph {
  const g = new Graph({ multi: true })
  g.addNode('a')
  g.addNode('b')
  for (let i = 0; i < count; i++) g.addEdge('a', 'b')
  return g
}

describe('createSigmaSettings', () => {
  it('draws straight edges by default and registers the straight and curved programs', () => {
    const settings = createSigmaSettings(graphWithEdges(1), darkColors)
    expect(settings.defaultEdgeType).toBe('line')
    for (const type of ['line', 'arrow', 'curve', 'curvedArrow']) expect(settings.edgeProgramClasses).toHaveProperty(type)
  })

  it('answers pointer events on edges so one can be hovered for its origin', () => {
    expect(createSigmaSettings(graphWithEdges(1), darkColors).enableEdgeEvents).toBe(true)
  })

  it('scales node size with the square root of the zoom, so zooming in by four doubles a node', () => {
    const settings = createSigmaSettings(graphWithEdges(1), darkColors)
    expect(settings.itemSizesReference).toBe('screen')
    const f = settings.zoomToSizeRatioFunction!
    const drawn = (size: number, ratio: number): number => size / f(ratio)
    expect(drawn(6, 1)).toBe(6)
    expect(drawn(6, 0.25)).toBe(12)
    expect(drawn(6, 4)).toBe(3)
  })

  it('budgets one label per grid cell at zoom 1, so density scales with the camera', () => {
    expect(createSigmaSettings(graphWithEdges(1), darkColors).labelDensity).toBe(1)
  })

  it('withholds labels from nodes rendered too small, so leaves earn theirs by zoom', () => {
    const settings = createSigmaSettings(graphWithEdges(1), darkColors)
    expect(settings.labelRenderedSizeThreshold).toBeGreaterThan(0)
  })

  it('hides edges on move only past the edge-count threshold', () => {
    expect(createSigmaSettings(graphWithEdges(1), darkColors).hideEdgesOnMove).toBe(false)
    expect(createSigmaSettings(graphWithEdges(HIDE_EDGES_ON_MOVE_ABOVE + 1), darkColors).hideEdgesOnMove).toBe(true)
  })
})
