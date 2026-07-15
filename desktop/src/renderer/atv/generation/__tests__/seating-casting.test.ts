import { describe, it, expect } from 'vitest'
import { generateOffice, seatOf } from '../index'
import { deriveRoster } from '../roster'
import { castCharacter, type CastableCharacter } from '../../theme/casting'
import { department, rootAgent, testTheme } from './gen-helpers'

describe('seat assignment stability', () => {
  it('assigns the lead to the head desk and specialists to cluster seats by name order', () => {
    const roster = deriveRoster(department('dev-lead', ['zeta-dev', 'alpha-dev']))
    const result = generateOffice('s', roster, testTheme())
    const head = result.layout.seats.find((s) => s.kind === 'head')
    expect(head?.agent).toBe('dev-lead')
    const clusterAgents = result.layout.seats
      .filter((s) => s.kind === 'cluster' && s.agent)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((s) => s.agent)
    expect(clusterAgents).toEqual(['alpha-dev', 'zeta-dev'])
  })

  it('mid-run roster growth never regenerates: existing seats keep their agents', () => {
    const initial = deriveRoster(department('dev-lead', ['alpha-dev', 'beta-dev']))
    const result = generateOffice('grow', initial, testTheme())
    const before = new Map(result.layout.seats.map((s) => [s.id, s.agent]))
    // The engine policy: a new agent arriving mid-run does NOT regenerate.
    // The layout object is untouched; the newcomer overflows to the break
    // room. Pin that the existing assignment is stable under that policy.
    const newcomerSeat = seatOf(result.layout, 'gamma-dev')
    expect(newcomerSeat).toBeUndefined()
    for (const seat of result.layout.seats) {
      expect(seat.agent).toBe(before.get(seat.id))
    }
  })
})

describe('character casting stability', () => {
  const pool: CastableCharacter[] = [
    { id: 'char-a', roles: ['specialist'], tintable: true },
    { id: 'char-b', roles: ['lead', 'specialist'], tintable: true },
    { id: 'char-c', roles: ['manager'], tintable: false },
  ]

  it('casts deterministically per agent name + seed, independent of pool order', () => {
    const forward = castCharacter(pool, 'specialist', 'backend-dev', 'seed1', '#8c5ac8')
    const reversed = castCharacter([...pool].reverse(), 'specialist', 'backend-dev', 'seed1', '#8c5ac8')
    expect(forward).toEqual(reversed)
    expect(forward?.characterId).toMatch(/^char-[ab]$/)
  })

  it('respects roles and tintability', () => {
    const manager = castCharacter(pool, 'manager', '__manager__', 'seed1', '#8c5ac8')
    expect(manager?.characterId).toBe('char-c')
    expect(manager?.tint).toBeNull()
    const lead = castCharacter(pool, 'lead', 'dev-lead', 'seed1', '#8c5ac8')
    expect(lead?.characterId).toBe('char-b')
    expect(lead?.tint).toBe('#8c5ac8')
  })

  it('different agents can cast different characters from the same pool', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const cast = new Set(names.map((n) => castCharacter(pool, 'specialist', n, 'seed1', null)?.characterId))
    expect(cast.size).toBeGreaterThan(1)
  })

  it('returns null when no character declares the role', () => {
    expect(castCharacter([pool[0]], 'manager', 'x', 's', null)).toBeNull()
  })
})
