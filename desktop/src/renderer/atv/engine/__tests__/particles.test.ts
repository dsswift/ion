import { describe, it, expect } from 'vitest'
import { spawnConfetti, tickParticles } from '../particles'
import { createRng } from '../../generation/prng'

describe('particles', () => {
  it('spawn produces n particles around the origin with upward velocity', () => {
    const ps = spawnConfetti(createRng('42'), 10, 5, 12)
    expect(ps).toHaveLength(12)
    for (const p of ps) {
      expect(Math.abs(p.x - 10)).toBeLessThan(2)
      expect(p.vy).toBeLessThan(0)
      expect(p.ttl).toBeGreaterThan(0)
    }
  })
  it('tick applies gravity and expires ttl', () => {
    let ps = spawnConfetti(createRng('1'), 0, 0, 5)
    const vy0 = ps[0].vy
    ps = tickParticles(ps, 0.1)
    expect(ps[0].vy).toBeGreaterThan(vy0) // gravity
    for (let i = 0; i < 40; i++) ps = tickParticles(ps, 0.1)
    expect(ps).toHaveLength(0) // all expired
  })
})
