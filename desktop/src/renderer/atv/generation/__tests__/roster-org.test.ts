import { describe, it, expect } from 'vitest'
import { deriveRoster } from '../roster'
import { generateOffice } from '../index'
import { testTheme } from './gen-helpers'
import type { AgentStateUpdate } from '../../../../shared/types'

function rosterAgent(name: string, metadata: Record<string, unknown> = {}): AgentStateUpdate {
  return { name, status: 'idle', metadata } as unknown as AgentStateUpdate
}

describe('org-metadata roster derivation (parentAgent + atv-* cascade)', () => {
  it('atv-seat governs the wing: executive joins it, private-office opts a chief out, rank alone does not qualify', () => {
    const agents = [
      // A chief over leads that explicitly opts OUT of the wing.
      rosterAgent('hands-on-chief', { 'atv-seat': 'private-office' }),
      rosterAgent('lead-a', { parentAgent: 'hands-on-chief' }),
      rosterAgent('a1', { parentAgent: 'lead-a' }),
      // A teamless top-level agent explicitly seated in the wing.
      rosterAgent('board-advisor', { 'atv-seat': 'executive' }),
      // A teamless top-level agent with no frontmatter: staff office, not wing.
      rosterAgent('scout', {}),
    ]
    const roster = deriveRoster(agents)
    expect(roster.executives.map((e) => e.name)).toEqual(['board-advisor'])
    expect(roster.departments.map((d) => d.lead.name)).toEqual(['hands-on-chief', 'lead-a'])
    expect(roster.solo.map((s) => s.name)).toEqual(['scout'])
  })

  it('executive seat overrides the corner office: team room without pocket, lead desk in the wing', () => {
    const agents = [
      rosterAgent('graphics-lead', { 'atv-seat': 'executive' }),
      rosterAgent('image-artist', { parentAgent: 'graphics-lead' }),
      rosterAgent('ux-designer', { parentAgent: 'graphics-lead' }),
    ]
    const roster = deriveRoster(agents)
    expect(roster.executives.map((e) => e.name)).toEqual(['graphics-lead'])
    expect(roster.departments).toEqual([
      expect.objectContaining({ leadInWing: true, specialists: expect.any(Array) }),
    ])

    const result = generateOffice('wing-override', roster, testTheme())
    expect(result.errors).toEqual([])
    const dept = result.layout.rooms.find((r) => r.id === 'dept-graphics-lead')!
    // No corner office carved; specialists seated in the department.
    expect(dept.innerOffice).toBeNull()
    expect(result.layout.seats.some((s) => s.roomId === dept.id && s.kind === 'head')).toBe(false)
    const deptAgents = result.layout.seats.filter((s) => s.roomId === dept.id && s.agent).map((s) => s.agent)
    expect(deptAgents.sort()).toEqual(['image-artist', 'ux-designer'])
    // The lead's desk is its executive-wing office.
    const wingSeat = result.layout.seats.find((s) => s.roomId === 'exec-graphics-lead' && s.kind === 'head')
    expect(wingSeat?.agent).toBe('graphics-lead')
  })

  it('executive-wing rooms occupy their own hallway spine (CEO included)', () => {
    const agents = [
      rosterAgent('chief-of-innovation', {}),
      rosterAgent('dev-lead', { parentAgent: 'chief-of-innovation' }),
      rosterAgent('ios-dev', { parentAgent: 'dev-lead' }),
      rosterAgent('graphics-lead', { parentAgent: 'chief-of-innovation' }),
      rosterAgent('image-artist', { parentAgent: 'graphics-lead' }),
    ]
    const roster = deriveRoster(agents)
    const result = generateOffice('wing', roster, testTheme())
    expect(result.errors).toEqual([])
    // Wing rooms (manager + exec offices) share a vertical band that no
    // general room overlaps: the wing is its own hallway.
    const isWing = (id: string) => id === 'manager' || id.startsWith('exec-')
    const wingRooms = result.layout.rooms.filter((r) => isWing(r.id))
    const otherRooms = result.layout.rooms.filter((r) => !isWing(r.id))
    expect(wingRooms.length).toBeGreaterThanOrEqual(2)
    const wingMaxY = Math.max(...wingRooms.map((r) => r.rect.y + r.rect.h))
    for (const room of otherRooms) {
      expect(room.rect.y, `${room.id} below the executive wing`).toBeGreaterThanOrEqual(wingMaxY)
    }
  })

  it('groups a full idle staff roster into departments by parentAgent — desks before any dispatch', () => {
    const agents = [
      rosterAgent('dev-lead', { type: 'lead' }),
      rosterAgent('ios-dev', { parentAgent: 'dev-lead' }),
      rosterAgent('desktop-dev', { parentAgent: 'dev-lead' }),
      rosterAgent('engine-dev', { parentAgent: 'dev-lead' }),
      rosterAgent('docs-lead', { type: 'lead' }),
      rosterAgent('writer', { parentAgent: 'docs-lead' }),
      rosterAgent('scout', {}),
    ]
    const roster = deriveRoster(agents)
    expect(roster.departments.map((d) => d.lead.name)).toEqual(['dev-lead', 'docs-lead'])
    expect(roster.departments[0].specialists.map((s) => s.name)).toEqual(['desktop-dev', 'engine-dev', 'ios-dev'])
    expect(roster.solo.map((s) => s.name)).toEqual(['scout'])

    // Every known agent gets a dedicated desk at generation time.
    const result = generateOffice('org', roster, testTheme())
    expect(result.errors).toEqual([])
    const assigned = result.layout.seats.filter((s) => s.agent != null).map((s) => s.agent).sort()
    expect(assigned).toEqual(['desktop-dev', 'dev-lead', 'docs-lead', 'engine-dev', 'ios-dev', 'scout', 'writer'])
  })

  it('chiefs over leads become executives with private wing offices', () => {
    const agents = [
      rosterAgent('chief-of-innovation', {}),
      rosterAgent('dev-lead', { parentAgent: 'chief-of-innovation' }),
      rosterAgent('ios-dev', { parentAgent: 'dev-lead' }),
      rosterAgent('graphics-lead', { parentAgent: 'chief-of-innovation' }),
      rosterAgent('image-artist', { parentAgent: 'graphics-lead' }),
    ]
    const roster = deriveRoster(agents)
    expect(roster.executives.map((e) => e.name)).toEqual(['chief-of-innovation'])
    expect(roster.departments.map((d) => d.lead.name)).toEqual(['dev-lead', 'graphics-lead'])

    const result = generateOffice('exec', roster, testTheme())
    expect(result.errors).toEqual([])
    const execSeat = result.layout.seats.find((s) => s.roomId === 'exec-chief-of-innovation')
    expect(execSeat?.agent).toBe('chief-of-innovation')
    expect(execSeat?.kind).toBe('head')
  })

  it('atv-* frontmatter: office grouping, executive seating, color and character pins', () => {
    const agents = [
      rosterAgent('advisor', { 'atv-seat': 'executive', parentAgent: 'nobody-known' }),
      rosterAgent('alpha', { 'atv-office': 'skunkworks', 'atv-color': '#123456' }),
      rosterAgent('beta', { 'atv-office': 'skunkworks', 'atv-character': 'spec-hoodie', parentAgent: 'alpha' }),
    ]
    // advisor has no children, but `atv-seat: executive` seats it in the wing.
    const withAdvisorChild = [...agents, rosterAgent('aide', { parentAgent: 'advisor' })]
    const roster = deriveRoster(withAdvisorChild)
    expect(roster.executives.map((e) => e.name)).toEqual(['advisor'])
    // skunkworks office: alpha leads (beta names alpha as parent).
    const skunk = roster.departments.find((d) => d.lead.name === 'alpha')
    expect(skunk).toBeDefined()
    expect(skunk!.lead.color).toBe('#123456')
    expect(skunk!.specialists.map((s) => s.name)).toEqual(['beta'])
    expect(skunk!.specialists[0].characterId).toBe('spec-hoodie')
  })
})

describe('named wings + visibility (atv-wing / atv-visible)', () => {
  it('atv-visible: never removes an agent from the office entirely', () => {
    const agents = [
      rosterAgent('dev-lead', {}),
      rosterAgent('ios-dev', { parentAgent: 'dev-lead' }),
      rosterAgent('ghost', { parentAgent: 'dev-lead', 'atv-visible': 'never' }),
    ]
    const roster = deriveRoster(agents)
    const names = [
      ...roster.departments.flatMap((d) => [d.lead.name, ...d.specialists.map((s) => s.name)]),
      ...roster.executives.map((e) => e.name),
      ...roster.solo.map((s) => s.name),
    ]
    expect(names).not.toContain('ghost')
    expect(names).toContain('ios-dev')
  })

  it('atv-wing groups offices onto their own hallway (consultants wing)', () => {
    const agents = [
      rosterAgent('dev-lead', {}),
      rosterAgent('ios-dev', { parentAgent: 'dev-lead' }),
      rosterAgent('consultant-a', { 'atv-wing': 'consultants' }),
      rosterAgent('consultant-b', { 'atv-wing': 'consultants' }),
      rosterAgent('scout', {}),
    ]
    const roster = deriveRoster(agents)
    expect(roster.solo.find((s) => s.name === 'consultant-a')?.wing).toBe('consultants')

    const result = generateOffice('wings', roster, testTheme())
    expect(result.errors).toEqual([])
    const rooms = result.layout.rooms
    const consultantRooms = rooms.filter((r) => r.id === 'office-consultant-a' || r.id === 'office-consultant-b')
    expect(consultantRooms).toHaveLength(2)
    // The consultants wing occupies its own vertical band: no non-wing room
    // overlaps its y-range (same invariant the executive wing carries).
    const wingMinY = Math.min(...consultantRooms.map((r) => r.rect.y))
    const wingMaxY = Math.max(...consultantRooms.map((r) => r.rect.y + r.rect.h))
    for (const room of rooms) {
      if (consultantRooms.includes(room)) continue
      const overlaps = room.rect.y < wingMaxY && room.rect.y + room.rect.h > wingMinY
      expect(overlaps, `${room.id} overlaps the consultants wing band`).toBe(false)
    }
  })
})

describe('hallway loops (no dead ends)', () => {
  it('multi-spine offices carry left, mid, and right vertical hallways', () => {
    // Enough departments to force multiple spines.
    const agents = Array.from({ length: 6 }, (_, i) => [
      rosterAgent(`lead-${i}`, {}),
      rosterAgent(`dev-${i}a`, { parentAgent: `lead-${i}` }),
      rosterAgent(`dev-${i}b`, { parentAgent: `lead-${i}` }),
    ]).flat()
    const roster = deriveRoster(agents)
    const result = generateOffice('loops', roster, testTheme())
    expect(result.errors).toEqual([])
    const { layout } = result
    const corridorYs = new Set<number>()
    // Find corridor rows: full-width floor spans (rooms never span full width).
    for (let y = 0; y < layout.height; y++) {
      let fullRow = true
      for (let x = 0; x < layout.width; x++) {
        const c = layout.cells[y * layout.width + x]
        if (c !== 1 && c !== 3) {
          fullRow = false
          break
        }
      }
      if (fullRow) corridorYs.add(y)
    }
    expect(corridorYs.size).toBeGreaterThanOrEqual(4) // >= 2 spines × 2 rows
    // Both END columns are hallway floor between first and last corridor row
    // (the ring: no horizontal hallway dead-ends).
    const ys = [...corridorYs].sort((a, b) => a - b)
    for (let y = ys[0]; y <= ys[ys.length - 1]; y++) {
      expect(layout.cells[y * layout.width + 0], `left ring column at y=${y}`).toBe(1)
      expect(layout.cells[y * layout.width + (layout.width - 1)], `right ring column at y=${y}`).toBe(1)
    }
  })
})
