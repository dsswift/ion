/**
 * campus — the zoomed-out scene: every conversation is a small building on
 * a lawn, glowing by live status. Deterministic seeded placement (stable
 * under insertion: position derives from the tabId hash, not list order).
 * Procedural building rendering ships art-free; packs may add sprites later.
 */
import { createRng, deriveSeed } from '../generation/prng'

export interface CampusEntry {
  tabId: string
  title: string
  state: string
  working: number
  error: number
  total: number
  pendingPermissions: number
}

export interface Building {
  tabId: string
  /** Tile-space rect (campus uses the office tile size). */
  x: number
  y: number
  w: number
  h: number
}

export const CAMPUS_COLS = 4
const LOT_W = 10
const LOT_H = 8
const BUILDING_W = 6
const BUILDING_H = 4

/** Deterministic lot assignment: sorted tabIds fill a grid; jitter by hash. */
export function layoutCampus(tabIds: readonly string[], seed: string): Building[] {
  const sorted = [...tabIds].sort()
  return sorted.map((tabId, i) => {
    const col = i % CAMPUS_COLS
    const row = Math.floor(i / CAMPUS_COLS)
    const rng = createRng(deriveSeed(seed, `campus:${tabId}`))
    return {
      tabId,
      x: col * LOT_W + 1 + rng.nextInt(LOT_W - BUILDING_W - 1),
      y: row * LOT_H + 1 + rng.nextInt(LOT_H - BUILDING_H - 1),
      w: BUILDING_W,
      h: BUILDING_H,
    }
  })
}

/** Campus bounds in tiles (for camera fit). */
export function campusSize(count: number): { w: number; h: number } {
  const rows = Math.max(1, Math.ceil(count / CAMPUS_COLS))
  return { w: CAMPUS_COLS * LOT_W, h: rows * LOT_H }
}

export interface Glow {
  color: string
  pulse: boolean
}

/** Status → building glow: attention beats error beats working beats idle. */
export function buildingGlow(entry: Pick<CampusEntry, 'state' | 'working' | 'error' | 'pendingPermissions'>): Glow {
  if (entry.pendingPermissions > 0) return { color: '#ffd23c', pulse: true }
  if (entry.error > 0 || entry.state === 'error' || entry.state === 'failed' || entry.state === 'dead') {
    return { color: '#ff5f5f', pulse: false }
  }
  if (entry.working > 0 || entry.state === 'running' || entry.state === 'connecting') {
    return { color: '#ff8c3c', pulse: true }
  }
  return { color: '#4a4f5e', pulse: false }
}

export function buildingAt(buildings: readonly Building[], tx: number, ty: number): Building | null {
  return buildings.find((b) => tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h) ?? null
}
