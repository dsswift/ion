import { describe, it, expect } from 'vitest'
import { generateOffice, serializeLayout } from '../index'
import { deriveRoster } from '../roster'
import { department, rootAgent, testTheme } from './gen-helpers'

describe('generator determinism', () => {
  const agents = [
    ...department('dev-lead', ['backend-dev', 'frontend-dev', 'qa-analyst']),
    ...department('docs-lead', ['writer']),
    rootAgent('scout'),
  ]

  it('same seed + same roster ⇒ byte-identical layout', () => {
    const roster = deriveRoster(agents)
    const a = generateOffice('alpha-seed', roster, testTheme())
    const b = generateOffice('alpha-seed', roster, testTheme())
    expect(serializeLayout(a.layout)).toBe(serializeLayout(b.layout))
  })

  it('roster input order does not affect the layout', () => {
    const forward = deriveRoster(agents)
    const reversed = deriveRoster([...agents].reverse())
    const a = generateOffice('alpha-seed', forward, testTheme())
    const b = generateOffice('alpha-seed', reversed, testTheme())
    expect(serializeLayout(a.layout)).toBe(serializeLayout(b.layout))
  })

  it('different seeds produce different layouts', () => {
    const roster = deriveRoster(agents)
    const a = generateOffice('alpha-seed', roster, testTheme())
    const b = generateOffice('beta-seed', roster, testTheme())
    expect(serializeLayout(a.layout)).not.toBe(serializeLayout(b.layout))
  })

  it('empty roster still yields a valid office with a remote-work room of guest desks', () => {
    const roster = deriveRoster([])
    const result = generateOffice('empty', roster, testTheme())
    expect(result.errors).toEqual([])
    // Baseline rooms: break, arrivals (lobby zone), remote office
    // (department), mail, manager suite, and a meeting room.
    expect(result.layout.rooms.map((r) => r.zone).sort()).toEqual([
      'break',
      'department',
      'lobby',
      'mail',
      'manager',
      'meeting',
    ])
    const hotDesks = result.layout.seats.filter((s) => s.kind === 'hot' && s.roomId === 'remote-office')
    expect(hotDesks.length).toBeGreaterThanOrEqual(3)
    expect(hotDesks.every((s) => s.agent === null)).toBe(true)
  })
})
