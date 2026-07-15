/**
 * scene-fx — per-scene visual state that is presentation, not simulation:
 * room lighting (this commit), heat/particles/dashboards (their own
 * commits). Rebuilt with the scene; reads OfficeState one-directionally;
 * OfficeState never grows for visuals.
 */
import type { OfficeState } from './office-state'
import type { OfficeLayout, Room } from '../generation/types'
import { createRng, deriveSeed, type AtvRng } from '../generation/prng'
import { spawnConfetti, tickParticles, MAX_PARTICLES, type Particle } from './particles'

/** Dim level for a room with nobody working in it. */
export const IDLE_ROOM_BRIGHTNESS = 0.55
/** Common rooms stay warmer while anyone in the office works. */
export const COMMONS_IDLE_BRIGHTNESS = 0.7
/** Whole-office night tint after this much orchestrator inactivity. */
export const NIGHT_AFTER_SECONDS = 300
export const NIGHT_BRIGHTNESS = 0.35

const COMMON_ZONES = new Set(['break', 'mail', 'lobby', 'meeting'])

/** Pure: target brightness per room for the current entity placement. */
export function roomBrightnessTargets(
  layout: OfficeLayout,
  entities: Iterable<{ working: boolean; sim: { x: number; y: number }; role: string }>,
): Map<string, number> {
  const targets = new Map<string, number>()
  let anyWorking = false
  const workingRooms = new Set<string>()
  const roomOf = (x: number, y: number): Room | undefined =>
    layout.rooms.find((r) => x >= r.rect.x && x < r.rect.x + r.rect.w && y >= r.rect.y && y < r.rect.y + r.rect.h)
  for (const e of entities) {
    if (e.role === 'pet' || !e.working) continue
    anyWorking = true
    const room = roomOf(Math.round(e.sim.x), Math.round(e.sim.y))
    if (room) workingRooms.add(room.id)
  }
  for (const room of layout.rooms) {
    if (workingRooms.has(room.id)) targets.set(room.id, 1)
    else if (COMMON_ZONES.has(room.zone)) targets.set(room.id, anyWorking ? 1 : COMMONS_IDLE_BRIGHTNESS)
    else targets.set(room.id, IDLE_ROOM_BRIGHTNESS)
  }
  return targets
}

/** Heat ramp color for a tile visit count vs the p95 reference. */
export function heatColor(count: number, p95: number): string | null {
  if (count <= 0) return null
  const alpha = Math.min(0.45, Math.log1p(count) / Math.log1p(Math.max(2, p95)) * 0.45)
  // Blue→orange ramp keyed to relative intensity.
  const t = Math.min(1, count / Math.max(1, p95))
  const r = Math.round(60 + t * 195)
  const g = Math.round(120 - t * 40)
  const b = Math.round(220 - t * 170)
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

export class SceneFx {
  /** Smoothed per-room brightness (0..1). */
  readonly brightness = new Map<string, number>()
  /** Whole-office multiplier (night tint). */
  globalBrightness = 1
  private idleSeconds = 0
  /** Footstep heat: cumulative tile visits this scene (reset with rebuild). */
  readonly visits: Uint32Array
  /** Cached p95 reference for the heat ramp (recomputed ~every 2s). */
  visitP95 = 1
  /** Heat overlay toggle (toolbar-driven; persisted as atvHeat). */
  heatEnabled = false
  /** Focus-mode highlight: names in the chain stay bright; others dim. */
  focusChain: Set<string> | null = null
  /** Live dashboard payload (dispatch statuses, cost sparkline, cost). */
  dashboardData = { dispatchStatuses: [] as string[], sparkline: [] as number[], conversationCostUsd: 0 }
  private p95Clock = 0
  private lastTile = new Map<string, number>()
  /** Live celebration particles (confetti). */
  particles: Particle[] = []
  private fxRng: AtvRng
  private prevWorkingCount = 0

  constructor(private layout: OfficeLayout) {
    for (const room of layout.rooms) this.brightness.set(room.id, 1)
    this.visits = new Uint32Array(layout.width * layout.height)
    this.fxRng = createRng(deriveSeed(layout.seed, 'fx'))
  }

  /**
   * Celebration trigger: the office finishes — working count crosses from
   * >0 to 0 with at least one completed agent → confetti at each finisher.
   * No retrigger while the count stays at zero.
   */
  private maybeCelebrate(office: OfficeState, workingCount: number): void {
    if (this.prevWorkingCount > 0 && workingCount === 0) {
      const finishers = [...office.entities.values()].filter((e) => e.completed && e.role !== 'pet')
      if (finishers.length > 0 && this.particles.length < MAX_PARTICLES) {
        for (const f of finishers) {
          this.particles.push(...spawnConfetti(this.fxRng, f.sim.x + 0.5, f.sim.y, 14))
        }
        this.particles = this.particles.slice(0, MAX_PARTICLES)
      }
    }
    this.prevWorkingCount = workingCount
  }

  /** Record entity movement into the visit grid (called from tick). */
  private accumulateVisits(office: OfficeState): void {
    for (const [name, e] of office.entities) {
      if (e.role === 'pet') continue
      const idx = Math.round(e.sim.y) * this.layout.width + Math.round(e.sim.x)
      if (idx < 0 || idx >= this.visits.length) continue
      // Count only tile CHANGES — standing still never inflates heat.
      if (this.lastTile.get(name) !== idx) {
        this.lastTile.set(name, idx)
        this.visits[idx] += 1
      }
    }
  }

  private refreshP95(dt: number): void {
    this.p95Clock += dt
    if (this.p95Clock < 2) return
    this.p95Clock = 0
    const nonZero = [...this.visits].filter((v) => v > 0).sort((a, b) => a - b)
    this.visitP95 = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length * 0.95)] || 1 : 1
  }

  /** Any orchestrator/office activity resets the night timer. */
  noteActivity(): void {
    this.idleSeconds = 0
  }

  tick(dt: number, office: OfficeState): void {
    const targets = roomBrightnessTargets(this.layout, office.entities.values())
    let workingCount = 0
    for (const e of office.entities.values()) {
      if (e.working && e.role !== 'pet') workingCount++
    }
    const anyWorking = workingCount > 0
    if (anyWorking) this.idleSeconds = 0
    else this.idleSeconds += dt
    this.maybeCelebrate(office, workingCount)
    this.particles = tickParticles(this.particles, dt)

    const nightTarget = this.idleSeconds > NIGHT_AFTER_SECONDS ? NIGHT_BRIGHTNESS : 1
    this.globalBrightness += (nightTarget - this.globalBrightness) * Math.min(1, dt * 1.5)

    for (const [roomId, target] of targets) {
      const current = this.brightness.get(roomId) ?? 1
      this.brightness.set(roomId, current + (target - current) * Math.min(1, dt * 2))
    }

    this.accumulateVisits(office)
    this.refreshP95(dt)
  }
}
