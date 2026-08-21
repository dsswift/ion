import { describe, it, expect } from 'vitest'
import { roomBrightnessTargets, SceneFx, heatColor, IDLE_ROOM_BRIGHTNESS, COMMONS_IDLE_BRIGHTNESS, NIGHT_AFTER_SECONDS, NIGHT_BRIGHTNESS } from '../scene-fx'
import type { OfficeLayout } from '../../generation/types'
import type { OfficeState } from '../office-state'

function layout(): OfficeLayout {
  return {
    seed: 's', width: 30, height: 20, cells: [],
    rooms: [
      { id: 'dept-a', zone: 'department', rect: { x: 0, y: 0, w: 10, h: 8 }, interior: { x: 1, y: 1, w: 8, h: 6 }, doorTiles: [], floorId: null, leadAgent: null, accent: null, innerOffice: null },
      { id: 'break', zone: 'break', rect: { x: 12, y: 0, w: 8, h: 8 }, interior: { x: 13, y: 1, w: 6, h: 6 }, doorTiles: [], floorId: null, leadAgent: null, accent: null, innerOffice: null },
    ],
    furniture: [], seats: [], restTiles: [], petSpawn: null, wallId: null, corridorFloorId: null,
  }
}
function entity(x: number, y: number, working: boolean, role = 'specialist') {
  return { working, sim: { x, y }, role }
}

describe('roomBrightnessTargets', () => {
  it('working occupant lights the room; empty rooms dim; commons follow office activity', () => {
    const t = roomBrightnessTargets(layout(), [entity(2, 2, true)])
    expect(t.get('dept-a')).toBe(1)
    expect(t.get('break')).toBe(1) // commons warm while anyone works
    const idle = roomBrightnessTargets(layout(), [entity(2, 2, false)])
    expect(idle.get('dept-a')).toBe(IDLE_ROOM_BRIGHTNESS)
    expect(idle.get('break')).toBe(COMMONS_IDLE_BRIGHTNESS)
  })
  it('pets never light rooms', () => {
    const t = roomBrightnessTargets(layout(), [entity(2, 2, true, 'pet')])
    expect(t.get('dept-a')).toBe(IDLE_ROOM_BRIGHTNESS)
  })
})

describe('SceneFx', () => {
  function officeWith(entities: ReturnType<typeof entity>[]): OfficeState {
    return { entities: new Map(entities.map((e, i) => [String(i), e])) } as unknown as OfficeState
  }

  it('brightness converges toward targets over ticks', () => {
    const fx = new SceneFx(layout())
    const office = officeWith([entity(2, 2, false)])
    for (let i = 0; i < 200; i++) fx.tick(1 / 30, office)
    expect(fx.brightness.get('dept-a')!).toBeCloseTo(IDLE_ROOM_BRIGHTNESS, 1)
  })

  it('night tint engages after sustained inactivity and clears on activity', () => {
    const fx = new SceneFx(layout())
    const idleOffice = officeWith([entity(2, 2, false)])
    for (let i = 0; i < NIGHT_AFTER_SECONDS + 60; i++) fx.tick(1, idleOffice)
    expect(fx.globalBrightness).toBeCloseTo(NIGHT_BRIGHTNESS, 1)
    const busy = officeWith([entity(2, 2, true)])
    for (let i = 0; i < 30; i++) fx.tick(1, busy)
    expect(fx.globalBrightness).toBeGreaterThan(0.9)
  })
})

describe('heat', () => {
  it('visit grid counts tile changes only; heatColor ramps and nulls at zero', () => {
    const fx = new SceneFx(layout())
    const walker = entity(2, 2, false)
    const office = officeLike([walker])
    fx.tick(1 / 30, office)
    fx.tick(1 / 30, office) // same tile: no double count
    walker.sim.x = 3
    fx.tick(1 / 30, office)
    const w = 30
    expect(fx.visits[2 * w + 2]).toBe(1)
    expect(fx.visits[2 * w + 3]).toBe(1)
    expect(heatColor(0, 10)).toBeNull()
    expect(heatColor(5, 10)).toMatch(/^rgba\(/)
  })
})

function officeLike(entities: ReturnType<typeof entity>[]): OfficeState {
  return { entities: new Map(entities.map((e, i) => [String(i), e])) } as unknown as OfficeState
}
