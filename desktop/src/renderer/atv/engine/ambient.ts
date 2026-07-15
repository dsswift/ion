/**
 * Ambient idle behavior: wandering, break-room rest, water-cooler pairing,
 * and pet wander. Draws from its own seeded RNG stream (independent of
 * generation) so ambience never perturbs layout determinism.
 */
import type { AtvRng } from '../generation/prng'
import type { OfficeLayout, Point, Room } from '../generation/types'
import type { Pathfinder } from './pathfind'
import type { CharacterSim } from './character'
import { transition } from './character'

/** Probability per second that an idle character starts a wander. */
const WANDER_CHANCE = 0.08
/** Probability per second that the pet moves. */
const PET_WANDER_CHANCE = 0.25

function randomWalkableIn(
  rng: AtvRng,
  pathfinder: Pathfinder,
  rect: { x: number; y: number; w: number; h: number },
  attempts = 8,
): Point | null {
  for (let i = 0; i < attempts; i++) {
    const x = rect.x + rng.nextInt(rect.w)
    const y = rect.y + rng.nextInt(rect.h)
    if (pathfinder.isWalkable(x, y)) return { x, y }
  }
  return null
}

/** Room the tile belongs to (undefined on the corridor). */
export function roomAt(layout: OfficeLayout, p: Point): Room | undefined {
  return layout.rooms.find(
    (r) => p.x >= r.rect.x && p.x < r.rect.x + r.rect.w && p.y >= r.rect.y && p.y < r.rect.y + r.rect.h,
  )
}

/** True when the tile is a permitted loitering spot for the entity: its own
 *  room or a common room. Hallways are for walking, never for stopping. */
function permittedLoiter(layout: OfficeLayout, p: Point, allowedRoomIds: ReadonlySet<string>): boolean {
  const room = roomAt(layout, p)
  if (!room) return false // corridor: walk through, never stop
  return room.zone === 'break' || room.zone === 'mail' || allowedRoomIds.has(room.id)
}

/**
 * Maybe start an ambient wander for an idle character.
 *
 * Wander targets respect office etiquette: a character roams the common
 * rooms (break room, mail room) and its OWN room, never other agents'
 * offices — and never stops in a hallway. Corridors are traversal only:
 * paths cross them, but no wander ever ends on a corridor tile.
 */
export function maybeWander(
  sim: CharacterSim,
  layout: OfficeLayout,
  pathfinder: Pathfinder,
  rng: AtvRng,
  dt: number,
  allowedRoomIds: ReadonlySet<string>,
): void {
  if (sim.state !== 'idle') return
  if (rng.next() > WANDER_CHANCE * dt) return
  const here = { x: Math.round(sim.x), y: Math.round(sim.y) }
  // Sample walkable tiles across the office; keep only permitted areas.
  for (let attempt = 0; attempt < 10; attempt++) {
    const target = randomWalkableIn(rng, pathfinder, { x: 0, y: 0, w: layout.width, h: layout.height }, 4)
    if (!target) continue
    if (!permittedLoiter(layout, target, allowedRoomIds)) continue
    const path = pathfinder.find(here, target)
    if (path && path.length > 0 && path.length <= 16) {
      transition(sim, { kind: 'walk', path, goal: 'idle' })
      return
    }
  }
}

/**
 * Move a character that has come to a stop on a corridor tile into the
 * nearest permitted loitering spot (own room, else a common room). Unlike
 * maybeWander this fires unconditionally and accepts longer paths: a
 * character never loiters in a hallway.
 */
export function leaveHallway(
  sim: CharacterSim,
  layout: OfficeLayout,
  pathfinder: Pathfinder,
  rng: AtvRng,
  allowedRoomIds: ReadonlySet<string>,
): void {
  const here = { x: Math.round(sim.x), y: Math.round(sim.y) }
  if (roomAt(layout, here)) return
  // Prefer the entity's own room, then the common rooms.
  const candidates = [
    ...layout.rooms.filter((r) => allowedRoomIds.has(r.id)),
    ...layout.rooms.filter((r) => r.zone === 'break' || r.zone === 'mail'),
  ]
  for (const room of candidates) {
    const target = randomWalkableIn(rng, pathfinder, room.interior, 8)
    if (!target) continue
    const path = pathfinder.find(here, target)
    if (path && path.length > 0) {
      transition(sim, { kind: 'walk', path, goal: 'idle' })
      return
    }
  }
}

/** Pet behavior: continuous lazy wander across the whole office. */
export function petWander(sim: CharacterSim, layout: OfficeLayout, pathfinder: Pathfinder, rng: AtvRng, dt: number): void {
  if (sim.state === 'walking') return
  if (rng.next() > PET_WANDER_CHANCE * dt) return
  const here = { x: Math.round(sim.x), y: Math.round(sim.y) }
  const target = randomWalkableIn(rng, pathfinder, { x: 0, y: 0, w: layout.width, h: layout.height }, 12)
  if (!target) return
  const path = pathfinder.find(here, target)
  if (path && path.length > 0 && path.length <= 20) {
    transition(sim, { kind: 'walk', path, goal: 'idle' })
  }
}

/**
 * Water-cooler pairing: when two or more characters idle in the break room,
 * turn adjacent pairs to face each other (a quiet chat).
 */
export function pairChatters(sims: Array<{ name: string; sim: CharacterSim }>, layout: OfficeLayout): void {
  const breakRoom = layout.rooms.find((r) => r.zone === 'break')
  if (!breakRoom) return
  const idleHere = sims.filter(({ sim }) => {
    if (sim.state !== 'idle' && sim.state !== 'resting') return false
    const room = roomAt(layout, { x: Math.round(sim.x), y: Math.round(sim.y) })
    return room?.id === breakRoom.id
  })
  for (let i = 0; i + 1 < idleHere.length; i += 2) {
    const a = idleHere[i].sim
    const b = idleHere[i + 1].sim
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 2) {
      a.dir = b.x >= a.x ? 'right' : 'left'
      b.dir = a.x >= b.x ? 'right' : 'left'
    }
  }
}
