/**
 * particles — tiny procedural celebration system (confetti). Pure functions
 * over plain state; SceneFx owns the array and its RNG stream (derived from
 * the scene seed — never generation's PRNG).
 */
import type { AtvRng } from '../generation/prng'

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  color: string
  ttl: number
}

const CONFETTI_COLORS = ['#ff5f5f', '#ffd23c', '#3ecf6e', '#5fa8ff', '#c95fff', '#ff9d3c']
export const MAX_PARTICLES = 160

/** Burst of confetti around (x, y) in tile coordinates. */
export function spawnConfetti(rng: AtvRng, x: number, y: number, n: number): Particle[] {
  const out: Particle[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      x: x + (rng.next() - 0.5) * 2,
      y: y + (rng.next() - 0.5),
      vx: (rng.next() - 0.5) * 8,
      vy: -4 - rng.next() * 5,
      color: CONFETTI_COLORS[rng.nextInt(CONFETTI_COLORS.length)],
      ttl: 1.2 + rng.next() * 0.8,
    })
  }
  return out
}

/** Advance particles one step: gravity, drag, ttl expiry. */
export function tickParticles(particles: Particle[], dt: number): Particle[] {
  const out: Particle[] = []
  for (const p of particles) {
    const ttl = p.ttl - dt
    if (ttl <= 0) continue
    out.push({
      x: p.x + p.vx * dt,
      y: p.y + p.vy * dt,
      vx: p.vx * (1 - dt * 1.5),
      vy: p.vy + 14 * dt,
      color: p.color,
      ttl,
    })
  }
  return out
}
