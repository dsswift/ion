import { describe, it, expect } from 'vitest'
import { layoutCampus, buildingGlow, buildingAt, campusSize, CAMPUS_COLS } from '../campus'

describe('layoutCampus', () => {
  it('is deterministic and stable under insertion (position keyed by tabId)', () => {
    const a = layoutCampus(['t-b', 't-a'], 'seed')
    const b = layoutCampus(['t-a', 't-b', 't-c'], 'seed')
    const posA = a.find((x) => x.tabId === 't-a')!
    const posB = b.find((x) => x.tabId === 't-a')!
    expect({ x: posA.x, y: posA.y }).toEqual({ x: posB.x, y: posB.y })
    expect(layoutCampus(['t-a', 't-b'], 'seed')).toEqual(layoutCampus(['t-b', 't-a'], 'seed'))
  })
  it('fills a grid without overlap', () => {
    const buildings = layoutCampus(Array.from({ length: 9 }, (_, i) => `tab-${i}`), 's')
    for (const b1 of buildings) {
      for (const b2 of buildings) {
        if (b1 === b2) continue
        const overlap = b1.x < b2.x + b2.w && b2.x < b1.x + b1.w && b1.y < b2.y + b2.h && b2.y < b1.y + b1.h
        expect(overlap).toBe(false)
      }
    }
    expect(campusSize(9).h).toBe(Math.ceil(9 / CAMPUS_COLS) * 8)
  })
})

describe('buildingGlow priority', () => {
  it('attention > error > working > idle', () => {
    expect(buildingGlow({ state: 'running', working: 3, error: 1, pendingPermissions: 1 }).color).toBe('#ffd23c')
    expect(buildingGlow({ state: 'running', working: 3, error: 1, pendingPermissions: 0 }).color).toBe('#ff5f5f')
    expect(buildingGlow({ state: 'running', working: 3, error: 0, pendingPermissions: 0 }).pulse).toBe(true)
    expect(buildingGlow({ state: 'idle', working: 0, error: 0, pendingPermissions: 0 }).pulse).toBe(false)
  })
})

describe('buildingAt', () => {
  it('hit-tests tile coordinates', () => {
    const buildings = layoutCampus(['t-1'], 's')
    const b = buildings[0]
    expect(buildingAt(buildings, b.x, b.y)?.tabId).toBe('t-1')
    expect(buildingAt(buildings, b.x + b.w, b.y)).toBeNull()
  })
})
