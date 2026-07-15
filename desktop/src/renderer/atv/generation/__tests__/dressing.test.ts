import { describe, it, expect } from 'vitest'
import { generateOffice } from '../index'
import { deriveRoster } from '../roster'
import { department, rootAgent, testTheme } from './gen-helpers'
import type { AtvFurnitureManifest } from '../../../../shared/types-atv'

describe('department rooms with inner lead offices', () => {
  it('every lead department gets one room: inner office for the lead, desks for every specialist', () => {
    const agents = [
      ...department('dev-lead', ['ios-dev', 'desktop-dev', 'engine-dev']),
      ...department('docs-lead', ['writer']),
      rootAgent('scout'),
    ]
    const roster = deriveRoster(agents)
    for (let i = 0; i < 8; i++) {
      const result = generateOffice(`inner-${i}`, roster, testTheme())
      expect(result.errors, `seed inner-${i}`).toEqual([])
      for (const dept of roster.departments) {
        const room = result.layout.rooms.find((r) => r.id === `dept-${dept.lead.name}`)!
        expect(room.innerOffice, `${dept.lead.name} inner office (seed ${i})`).not.toBeNull()
        // The lead's head seat sits INSIDE the inner-office pocket.
        const head = result.layout.seats.find((s) => s.roomId === room.id && s.kind === 'head')!
        expect(head.agent).toBe(dept.lead.name)
        const inner = room.innerOffice!
        expect(head.tile.x).toBeGreaterThanOrEqual(inner.interior.x)
        expect(head.tile.x).toBeLessThan(inner.interior.x + inner.interior.w)
        expect(head.tile.y).toBeGreaterThanOrEqual(inner.interior.y)
        expect(head.tile.y).toBeLessThan(inner.interior.y + inner.interior.h)
        // Every specialist has a cluster desk in the department room body.
        const clusterAgents = result.layout.seats
          .filter((s) => s.roomId === room.id && s.kind === 'cluster' && s.agent)
          .map((s) => s.agent)
        expect(clusterAgents.sort()).toEqual(dept.specialists.map((s) => s.name).sort())
      }
      // The bullpen (solo agents) has no inner office.
      const bullpen = result.layout.rooms.find((r) => r.id === 'bullpen')
      expect(bullpen?.innerOffice ?? null).toBeNull()
    }
  })

  it('inner-office corner varies with the seed (procedural variation)', () => {
    const roster = deriveRoster(department('dev-lead', ['a-dev', 'b-dev']))
    const corners = new Set<string>()
    for (let i = 0; i < 12; i++) {
      const result = generateOffice(`corner-${i}`, roster, testTheme())
      const room = result.layout.rooms.find((r) => r.id === 'dept-dev-lead')!
      const inner = room.innerOffice!
      corners.add(inner.rect.x === room.rect.x ? 'left' : 'right')
    }
    expect(corners.size).toBeGreaterThan(1)
  })
})

describe('floor assignment', () => {
  it('every room gets a floor and the corridor gets its own (from the corridor template)', () => {
    const roster = deriveRoster([...department('dev-lead', ['a-dev']), rootAgent('scout')])
    const result = generateOffice('floors', roster, testTheme())
    expect(result.errors).toEqual([])
    // Corridor floor comes from the corridor dressing template, not the
    // room fallback — hallways must be render-distinguishable from rooms.
    expect(result.layout.corridorFloorId).toBe('plank')
    for (const room of result.layout.rooms) {
      expect(room.floorId, `${room.id} floor`).not.toBeNull()
    }
  })
})

describe('multi-anchor required dressing', () => {
  it('places every required anchor item in a room, not just the first', () => {
    const theme = testTheme()
    // Two more blocking anchor items alongside the sofa in the break room —
    // the anchor scan must find distinct spots for all three (the original
    // center-only anchor placed only the first and silently dropped the rest).
    const cooler: AtvFurnitureManifest = {
      id: 'cooler', name: 'Cooler', category: 'relax', footprintW: 1, footprintH: 1,
      width: 16, height: 32, rotationScheme: 'none', images: { default: 'd.png' },
    }
    const bar: AtvFurnitureManifest = {
      id: 'bar', name: 'Bar', category: 'relax', footprintW: 2, footprintH: 1,
      width: 32, height: 32, rotationScheme: 'none', images: { default: 'd.png' },
    }
    theme.furniture.set('cooler', cooler)
    theme.furniture.set('bar', bar)
    theme.dressing.set('break', {
      zone: 'break',
      floor: 'plank',
      required: [
        { id: 'sofa', count: 1 },
        { id: 'bar', count: 1 },
        { id: 'cooler', count: 1 },
      ],
      optional: [],
      density: 0,
    })

    const roster = deriveRoster(department('dev-lead', ['a-dev']))
    const result = generateOffice('multi-anchor', roster, theme)
    expect(result.errors).toEqual([])
    const breakRoom = result.layout.rooms.find((r) => r.zone === 'break')!
    const placedHere = result.layout.furniture.filter((f) => f.roomId === breakRoom.id).map((f) => f.itemId)
    expect(placedHere).toEqual(expect.arrayContaining(['sofa', 'bar', 'cooler']))
    // Nothing landed on the sofa's rest tiles.
    for (const rest of result.layout.restTiles) {
      const overlapping = result.layout.furniture.filter(
        (f) => f.itemId !== 'sofa' && f.x <= rest.x && rest.x < f.x + (theme.furniture.get(f.itemId)?.footprintW ?? 1) && f.y === rest.y,
      )
      expect(overlapping).toEqual([])
    }
  })
})
