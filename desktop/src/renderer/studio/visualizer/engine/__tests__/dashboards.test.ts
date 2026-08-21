import { describe, it, expect } from 'vitest'
import { kanbanCards, sparklinePoints } from '../dashboards'

describe('kanbanCards', () => {
  it('sorts statuses into queued/running/done columns', () => {
    const cards = kanbanCards(['pending', 'running', 'running', 'done'], 30, 12)
    expect(cards.filter((c) => c.col === 0)).toHaveLength(1)
    expect(cards.filter((c) => c.col === 1)).toHaveLength(2)
    expect(cards.filter((c) => c.col === 2)).toHaveLength(1)
    // Cards stack downward within a column.
    const running = cards.filter((c) => c.col === 1)
    expect(running[1].y).toBeGreaterThan(running[0].y)
  })
  it('caps overflow per column without throwing', () => {
    const cards = kanbanCards(Array(50).fill('running'), 30, 9)
    expect(cards.length).toBeLessThanOrEqual(3)
  })
})

describe('sparklinePoints', () => {
  it('scales a rising series into the region', () => {
    const pts = sparklinePoints([1, 2, 3], 20, 10)
    expect(pts[0]).toEqual({ x: 0, y: 9 })
    expect(pts[2]).toEqual({ x: 19, y: 0 })
  })
  it('flat series stays on one line; short series yields nothing', () => {
    const pts = sparklinePoints([5, 5, 5], 20, 10)
    expect(new Set(pts.map((p) => p.y)).size).toBe(1)
    expect(sparklinePoints([5], 20, 10)).toEqual([])
  })
})
