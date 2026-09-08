import { describe, expect, it } from 'vitest'
import { convexHull, paddedOutline, polygonArea, selectDrawableHulls, SPARSE_HULL_FACTOR, type Point } from './hull-geometry'

const square: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]

describe('convexHull', () => {
  it('drops interior points and keeps the corners', () => {
    const hull = convexHull([...square, { x: 5, y: 5 }, { x: 2, y: 3 }])
    expect(hull).toHaveLength(4)
    for (const corner of square) expect(hull).toContainEqual(corner)
  })
})

describe('paddedOutline', () => {
  it('offsets every straight run outward by the padding and rounds every corner around its vertex', () => {
    const padding = 4
    const segments = paddedOutline(square, padding)
    expect(segments).toHaveLength(4)
    for (const segment of segments) {
      // The vertex the arc turns around is one of the hull's own corners.
      expect(square).toContainEqual(segment.center)
      // The run's endpoints sit exactly `padding` outside the square.
      for (const p of [segment.from, segment.to]) {
        const outsideX = p.x < 0 - 1e-9 || p.x > 10 + 1e-9
        const outsideY = p.y < 0 - 1e-9 || p.y > 10 + 1e-9
        expect(outsideX || outsideY).toBe(true)
        const dx = Math.max(0 - p.x, p.x - 10, 0)
        const dy = Math.max(0 - p.y, p.y - 10, 0)
        expect(Math.hypot(dx, dy)).toBeCloseTo(padding)
      }
    }
  })

  it('offsets outward regardless of the hull vertex order', () => {
    const reversed = [...square].reverse()
    const centroid = { x: 5, y: 5 }
    for (const segment of paddedOutline(reversed, 4)) {
      expect(Math.hypot(segment.from.x - centroid.x, segment.from.y - centroid.y)).toBeGreaterThan(5)
    }
  })

  it('yields nothing for fewer than three vertices', () => {
    expect(paddedOutline(square.slice(0, 2), 4)).toEqual([])
  })
})

describe('selectDrawableHulls', () => {
  const compact = (tag: number, members: number): { hull: Point[]; memberCount: number; tag: number } => ({ hull: square, memberCount: members, tag })

  it('drops a hull whose area per member dwarfs the median', () => {
    const shard = { hull: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }], memberCount: 3, tag: 99 }
    const kept = selectDrawableHulls([compact(1, 10), compact(2, 12), compact(3, 8), shard])
    expect(kept.map((c) => c.tag)).toEqual([1, 2, 3])
  })

  it('keeps every hull when they are all similarly dense', () => {
    const candidates = [compact(1, 10), compact(2, 10), compact(3, 10)]
    expect(selectDrawableHulls(candidates)).toHaveLength(3)
  })

  it('keeps everything when there are too few hulls to judge a median', () => {
    const shard = { hull: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }], memberCount: 3, tag: 99 }
    expect(selectDrawableHulls([compact(1, 10), shard])).toHaveLength(2)
  })

  it('the threshold is the median density times the sparse factor', () => {
    const median = polygonArea(square) / 10
    const limit = median * SPARSE_HULL_FACTOR
    // A right triangle with legs L has area L² / 2; one member, so its
    // density is its area.
    const triangle = (area: number, tag: number) => {
      const leg = Math.sqrt(area * 2)
      return { hull: [{ x: 0, y: 0 }, { x: leg, y: 0 }, { x: 0, y: leg }], memberCount: 1, tag }
    }
    const base = [compact(1, 10), compact(2, 10), compact(3, 10)]
    expect(selectDrawableHulls([...base, triangle(limit - 1, 4)]).map((c) => c.tag)).toContain(4)
    expect(selectDrawableHulls([...base, triangle(limit + 1, 5)]).map((c) => c.tag)).not.toContain(5)
  })
})
