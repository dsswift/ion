/**
 * Reachability and invariant validation for generated offices. Used both at
 * generation time (dressing rolls back placements that break reachability)
 * and by the invariant tests.
 */
import { Cell, cellAt, type OfficeLayout, type Point } from './types'

/**
 * Tiles a character can stand on: floor and door cells that no blocking
 * furniture occupies. `blocked` is the dressing-time occupancy set
 * (`x,y` keys); pass an empty set to test the bare shell.
 */
export function buildWalkability(layout: OfficeLayout, blocked: ReadonlySet<string>): boolean[] {
  const walkable = new Array<boolean>(layout.width * layout.height).fill(false)
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      const cell = cellAt(layout, x, y)
      walkable[y * layout.width + x] =
        (cell === Cell.Floor || cell === Cell.Door) && !blocked.has(`${x},${y}`)
    }
  }
  return walkable
}

/** BFS flood from a start point over a walkability grid. */
export function floodFrom(layout: OfficeLayout, walkable: readonly boolean[], start: Point): boolean[] {
  const reached = new Array<boolean>(layout.width * layout.height).fill(false)
  const idx = (p: Point) => p.y * layout.width + p.x
  if (!walkable[idx(start)]) return reached
  const queue: Point[] = [start]
  reached[idx(start)] = true
  while (queue.length > 0) {
    const p = queue.shift()!
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = p.x + dx
      const ny = p.y + dy
      if (nx < 0 || ny < 0 || nx >= layout.width || ny >= layout.height) continue
      const ni = ny * layout.width + nx
      if (walkable[ni] && !reached[ni]) {
        reached[ni] = true
        queue.push({ x: nx, y: ny })
      }
    }
  }
  return reached
}

/** A corridor tile to flood from (any walkable tile outside every room). */
export function corridorStart(layout: OfficeLayout): Point | null {
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      if (cellAt(layout, x, y) !== Cell.Floor) continue
      const inRoom = layout.rooms.some(
        (r) => x >= r.rect.x && x < r.rect.x + r.rect.w && y >= r.rect.y && y < r.rect.y + r.rect.h,
      )
      if (!inRoom) return { x, y }
    }
  }
  return null
}

/**
 * Full invariant check: grid within cap, every door and seat and rest tile
 * BFS-reachable from the corridor. Returns human-readable violations
 * (empty = valid).
 */
export function validateLayout(layout: OfficeLayout, blocked: ReadonlySet<string>): string[] {
  const errors: string[] = []
  if (layout.width > 64 || layout.height > 64) {
    errors.push(`grid ${layout.width}x${layout.height} exceeds 64x64`)
  }
  const start = corridorStart(layout)
  if (!start) return ['no corridor tile found']
  const walkable = buildWalkability(layout, blocked)
  const reached = floodFrom(layout, walkable, start)
  const check = (p: Point, label: string) => {
    if (!reached[p.y * layout.width + p.x]) errors.push(`${label} at ${p.x},${p.y} unreachable`)
  }
  for (const room of layout.rooms) {
    for (const door of room.doorTiles) check(door, `door of ${room.id}`)
  }
  for (const seat of layout.seats) check(seat.tile, `seat ${seat.id}`)
  for (const rest of layout.restTiles) check(rest, 'rest tile')
  return errors
}
