import { describe, expect, it } from 'vitest'
import { minimapPointToGraph, projectMinimap, viewportCoversGraph } from './minimap-projection'

const SIZE = { width: 160, height: 110 }

describe('projectMinimap', () => {
  it('fits the graph bounding box inside the margin and keeps the aspect ratio', () => {
    // Graph spans 200 x 50; the minimap's inner box is 148 x 98, so width limits: scale = 0.74.
    const points = [{ x: 0, y: 0 }, { x: 200, y: 50 }, { x: 100, y: 25 }]
    const projection = projectMinimap(points, [], SIZE)!
    expect(projection.scale).toBeCloseTo(0.74)
    expect(projection.dots[0]).toEqual({ x: 6, y: expect.closeTo(6 + (98 - 50 * 0.74) / 2, 5) })
    expect(projection.dots[1].x).toBeCloseTo(154)
    expect(projection.dots[2].x).toBeCloseTo(80)
  })

  it('projects the viewport corners into a rectangle', () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 100 }]
    const corners = [{ x: 25, y: 25 }, { x: 75, y: 25 }, { x: 75, y: 75 }, { x: 25, y: 75 }]
    const projection = projectMinimap(points, corners, SIZE)!
    // scale = min(148/100, 98/100) = 0.98; the box is centred horizontally.
    expect(projection.scale).toBeCloseTo(0.98)
    expect(projection.viewportRect.width).toBeCloseTo(49)
    expect(projection.viewportRect.height).toBeCloseTo(49)
    expect(projection.viewportRect.x).toBeCloseTo(projection.offset.x + 25 * 0.98)
  })

  it('a single node lands centred with a finite scale', () => {
    const projection = projectMinimap([{ x: 42, y: 42 }], [], SIZE)!
    expect(Number.isFinite(projection.scale)).toBe(true)
    expect(projection.dots[0].x).toBeCloseTo(80)
    expect(projection.dots[0].y).toBeCloseTo(55)
  })

  it('ignores non-finite points and returns null with nothing left', () => {
    expect(projectMinimap([{ x: Number.NaN, y: 1 }], [], SIZE)).toBeNull()
    expect(projectMinimap([], [], SIZE)).toBeNull()
  })
})

describe('minimapPointToGraph', () => {
  it('inverts the projection', () => {
    const points = [{ x: -50, y: 10 }, { x: 350, y: 210 }]
    const projection = projectMinimap(points, [], SIZE)!
    for (const p of points) {
      const back = minimapPointToGraph(projection.dots[points.indexOf(p)], projection)
      expect(back.x).toBeCloseTo(p.x)
      expect(back.y).toBeCloseTo(p.y)
    }
  })
})

describe('viewportCoversGraph', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 100 }]
  it('is true when every dot is inside the viewport rectangle', () => {
    const projection = projectMinimap(points, [{ x: -10, y: -10 }, { x: 110, y: -10 }, { x: 110, y: 110 }, { x: -10, y: 110 }], SIZE)!
    expect(viewportCoversGraph(projection)).toBe(true)
  })
  it('is false when the viewport shows only part of the graph', () => {
    const projection = projectMinimap(points, [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }], SIZE)!
    expect(viewportCoversGraph(projection)).toBe(false)
  })
})
