/**
 * Stage 3 — zone dressing: furnish each room from the active theme pack's
 * dressing templates. Walkability is never sacrificed: every placement that
 * would cut off a seat, door, or rest tile is rolled back.
 *
 * The generator core stays theme-agnostic — which items dress a zone comes
 * entirely from pack data. Per-seat items are resolved by capability, not by
 * hardcoded id: the surface item is the desk, the seatTiles item is the
 * chair, the canPlaceOnSurfaces item goes on the desk.
 */
import type { AtvDressingTemplate, AtvFurnitureManifest } from '../../../shared/types-atv'
import type { AtvRng } from './prng'
import { CLUSTER, type RoomSpec } from './program'
import { buildWalkability, corridorStart, validateLayout } from './validate'
import { Cell, cellAt, type GenTheme, type OfficeLayout, type PlacedFurniture, type Room, type Seat } from './types'

interface DressContext {
  layout: OfficeLayout
  theme: GenTheme
  rng: AtvRng
  /** Tiles blocked by furniture footprints (`x,y` keys). */
  blocked: Set<string>
}

function manifest(theme: GenTheme, id: string): AtvFurnitureManifest | undefined {
  return theme.furniture.get(id)
}

function defaultVariant(m: AtvFurnitureManifest): string {
  if (m.states && Object.keys(m.states).length > 0) return Object.keys(m.states).sort()[0]
  if (m.rotationScheme === '2-way') return 'front'
  if (m.rotationScheme === '3-way-mirror') return 'down'
  return 'default'
}

function footprintTiles(m: AtvFurnitureManifest, x: number, y: number): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = []
  for (let dy = 0; dy < m.footprintH; dy++) {
    for (let dx = 0; dx < m.footprintW; dx++) tiles.push({ x: x + dx, y: y + dy })
  }
  return tiles
}

function isFree(ctx: DressContext, room: Room, m: AtvFurnitureManifest, x: number, y: number, seats: Seat[]): boolean {
  for (const t of footprintTiles(m, x, y)) {
    if (
      t.x < room.interior.x ||
      t.y < room.interior.y ||
      t.x >= room.interior.x + room.interior.w ||
      t.y >= room.interior.y + room.interior.h
    ) {
      return false
    }
    // Furniture stands on floor only — never on inner-office walls or doors.
    if (cellAt(ctx.layout, t.x, t.y) !== Cell.Floor) return false
    if (ctx.blocked.has(`${t.x},${t.y}`)) return false
    if (seats.some((s) => s.tile.x === t.x && s.tile.y === t.y)) return false
    // Rest tiles (sofa/bench seats) are walk-on tiles, not blocked cells —
    // but nothing else may be placed on top of them.
    if (ctx.layout.restTiles.some((r) => r.x === t.x && r.y === t.y)) return false
  }
  return true
}

function place(ctx: DressContext, room: Room, m: AtvFurnitureManifest, x: number, y: number, opts?: { onSurface?: boolean; variant?: string }): PlacedFurniture {
  const placed: PlacedFurniture = {
    itemId: m.id,
    x,
    y,
    variant: opts?.variant ?? defaultVariant(m),
    roomId: room.id,
    onSurface: opts?.onSurface ?? false,
  }
  ctx.layout.furniture.push(placed)
  // Blocking: seat items are walked onto, background/wall/surface items don't
  // occupy floor. Everything else blocks its footprint.
  const blocks =
    !opts?.onSurface &&
    !(m.seatTiles && m.seatTiles.length > 0) &&
    !m.backgroundTiles &&
    !m.canPlaceOnWalls
  if (blocks) {
    for (const t of footprintTiles(m, x, y)) ctx.blocked.add(`${t.x},${t.y}`)
  }
  return placed
}

/** Resolve per-seat items from a template by capability. */
function perSeatItems(ctx: DressContext, template: AtvDressingTemplate): {
  desk: AtvFurnitureManifest | null
  chair: AtvFurnitureManifest | null
  onDesk: AtvFurnitureManifest | null
} {
  const perSeat = template.required
    .filter((e) => e.perSeat && e.id)
    .map((e) => manifest(ctx.theme, e.id!))
    .filter((m): m is AtvFurnitureManifest => !!m)
  return {
    desk: perSeat.find((m) => m.isSurface) ?? null,
    chair: perSeat.find((m) => (m.seatTiles?.length ?? 0) > 0) ?? null,
    onDesk: perSeat.find((m) => m.canPlaceOnSurfaces) ?? null,
  }
}

/**
 * One desk+chair(+surface item) group, placed atomically: nothing lands
 * unless both the desk and the chair fit. Returns the seat tile or null.
 * Anchors adjacent to a door (room or inner-office) are refused so a desk
 * row can never block a doorway.
 */
function placeSeatGroup(
  ctx: DressContext,
  room: Room,
  items: ReturnType<typeof perSeatItems>,
  x: number,
  y: number,
  flip = false,
): { x: number; y: number } | null {
  if (!items.desk || !items.chair) return null
  // Normal: desk on the anchor row, chair below, occupant faces up.
  // Flipped (inner office whose door is above): chair on the anchor row,
  // desk below, occupant faces down.
  const deskY = flip ? y + items.chair.footprintH : y
  const chairY = flip ? y : y + items.desk.footprintH
  // The desk BLOCKS its tiles, so it must stay off every door's approach
  // tiles (the four neighbors a character crosses through). The chair is
  // walkable — sitting right inside a doorway's reach is fine (and is the
  // normal shape inside the tiny inner office).
  const doors = [...room.doorTiles, ...(room.innerOffice ? [room.innerOffice.door] : [])]
  const deskTiles = footprintTiles(items.desk, x, deskY)
  const blocksDoor = doors.some((d) =>
    deskTiles.some((t) => Math.abs(d.x - t.x) + Math.abs(d.y - t.y) <= 1),
  )
  if (blocksDoor) return null
  if (!isFree(ctx, room, items.desk, x, deskY, ctx.layout.seats)) return null
  if (!isFree(ctx, room, items.chair, x, chairY, ctx.layout.seats)) return null
  place(ctx, room, items.desk, x, deskY)
  if (items.onDesk) place(ctx, room, items.onDesk, x, deskY, { onSurface: true })
  place(ctx, room, items.chair, x, chairY, {
    variant: items.chair.rotationScheme === '3-way-mirror' ? (flip ? 'down' : 'up') : undefined,
  })
  return { x, y: chairY }
}

function dressClusterRoom(ctx: DressContext, room: Room, spec: RoomSpec, template: AtvDressingTemplate): void {
  const items = perSeatItems(ctx, template)
  const ix = room.interior.x
  // One-row circulation margin below the top wall: bottom-band rooms have
  // their door in that wall, and a desk row flush against it can land under
  // the doorway and seal the room. The program's interior heights budget for
  // this margin.
  const iy = room.interior.y + 1

  // The lead's desk group lives inside the inner-office pocket when the room
  // has one; without a pocket (legacy shape) it sits centered on the top row.
  if (spec.lead && !spec.leadInWing) {
    const inner = room.innerOffice
    const headX = inner ? inner.interior.x : ix + Math.max(0, Math.floor((room.interior.w - (items.desk?.footprintW ?? 2)) / 2))
    const headY = inner ? inner.interior.y : iy
    // Inner offices whose door sits above the pocket (bottom-band rooms)
    // flip the group: chair by the door, desk beneath, lead facing down.
    const flip = inner != null && inner.door.y < inner.interior.y
    const tile = placeSeatGroup(ctx, room, items, headX, headY, flip)
    if (tile) {
      ctx.layout.seats.push({
        id: `${room.id}:head`,
        roomId: room.id,
        tile,
        dir: flip ? 'down' : 'up',
        kind: 'head',
        agent: null,
      })
    }
  }

  // Specialist cluster: scan candidate desk anchors row by row across the
  // room body (the isFree cell check steers around the inner office and its
  // door automatically) until every specialist has a seat. A seeded column
  // offset varies the arrangement between seeds when spare width exists.
  const spare = Math.max(0, room.interior.w - Math.min(spec.clusterAgents.length, CLUSTER.columns) * CLUSTER.columnPitch - 1)
  const colOffset = spare > 0 ? ctx.rng.nextInt(Math.min(spare, 3)) : 0
  // Cluster desks for the team, then spare guest desks (seat kind 'hot')
  // continuing the same grid — a visiting agent sits at a real workstation.
  const totalSeats = spec.clusterAgents.length + spec.spareSeats
  let seated = 0
  const maxRows = Math.ceil(room.interior.h / CLUSTER.rowPitch) + 2
  for (let row = 0; row < maxRows && seated < totalSeats; row++) {
    for (let col = 0; col < CLUSTER.columns && seated < totalSeats; col++) {
      const x = ix + colOffset + col * CLUSTER.columnPitch
      const y = iy + row * CLUSTER.rowPitch
      const tile = placeSeatGroup(ctx, room, items, x, y)
      if (tile) {
        const isSpare = seated >= spec.clusterAgents.length
        ctx.layout.seats.push({
          id: `${room.id}:${isSpare ? 'h' : 'c'}${seated}`,
          roomId: room.id,
          tile,
          dir: 'up',
          kind: isSpare ? 'hot' : 'cluster',
          agent: null,
        })
        seated++
      }
    }
  }
}

function dressCountRoom(ctx: DressContext, room: Room, template: AtvDressingTemplate, seatKind: 'manager' | 'head' | null): void {
  const ix = room.interior.x
  // Same one-row circulation margin as cluster rooms (door-wall clearance).
  const iy = room.interior.y + 1
  let surface: { m: AtvFurnitureManifest; x: number; y: number } | null = null
  for (const entry of template.required) {
    if (!entry.id || entry.perSeat) continue
    const m = manifest(ctx.theme, entry.id)
    if (!m) continue
    const count = entry.count ?? 1
    for (let i = 0; i < count; i++) {
      if (m.canPlaceOnWalls) {
        placeOnWall(ctx, room, m)
      } else if (m.canPlaceOnSurfaces && surface) {
        place(ctx, room, m, surface.x, surface.y, { onSurface: true })
      } else if ((m.seatTiles?.length ?? 0) > 0 && surface) {
        const chairX = surface.x + Math.floor((surface.m.footprintW - m.footprintW) / 2)
        const chairY = surface.y + surface.m.footprintH
        if (isFree(ctx, room, m, chairX, chairY, ctx.layout.seats)) {
          place(ctx, room, m, chairX, chairY, { variant: m.rotationScheme === '3-way-mirror' ? 'up' : undefined })
          if (seatKind) {
            ctx.layout.seats.push({ id: room.id, roomId: room.id, tile: { x: chairX, y: chairY }, dir: 'up', kind: seatKind, agent: null })
          }
        }
      } else {
        // Anchor item: prefer centered against the top of the interior, then
        // scan across and down for the first free spot — rooms with several
        // required anchors (sofa + coffee bar + water cooler) place them all.
        const centered = ix + Math.max(0, Math.floor((room.interior.w - m.footprintW) / 2))
        const candidates: Array<{ x: number; y: number }> = [{ x: centered, y: iy }]
        for (let y = iy; y < room.interior.y + room.interior.h - 1; y += 2) {
          for (let x = ix; x <= room.interior.x + room.interior.w - m.footprintW; x++) {
            candidates.push({ x, y })
          }
        }
        const spot = candidates.find((c) => isFree(ctx, room, m, c.x, c.y, ctx.layout.seats))
        if (spot) {
          const placed = place(ctx, room, m, spot.x, spot.y)
          if (m.isSurface) surface = { m, x: placed.x, y: placed.y }
          if ((m.seatTiles?.length ?? 0) > 0) {
            for (const st of m.seatTiles ?? []) {
              ctx.layout.restTiles.push({ x: placed.x + st.x, y: placed.y + st.y })
            }
          }
        }
      }
    }
  }
}

function placeOnWall(ctx: DressContext, room: Room, m: AtvFurnitureManifest): boolean {
  // Wall items hang on the room's top wall row, skipping door tiles.
  const wallY = room.rect.y
  const xs: number[] = []
  for (let x = room.interior.x; x <= room.interior.x + room.interior.w - m.footprintW; x++) xs.push(x)
  for (const x of ctx.rng.shuffle(xs)) {
    const overlapsDoor = room.doorTiles.some((d) => d.y === wallY && d.x >= x && d.x < x + m.footprintW)
    const occupied = footprintTiles(m, x, wallY).some((t) => ctx.blocked.has(`w${t.x},${t.y}`))
    if (overlapsDoor || occupied) continue
    ctx.layout.furniture.push({ itemId: m.id, x, y: wallY, variant: defaultVariant(m), roomId: room.id, onSurface: false })
    for (const t of footprintTiles(m, x, wallY)) ctx.blocked.add(`w${t.x},${t.y}`)
    return true
  }
  return false
}

function dressOptional(ctx: DressContext, room: Room, template: AtvDressingTemplate): void {
  const interiorArea = room.interior.w * room.interior.h
  const freeTiles = () => {
    let n = 0
    for (let y = room.interior.y; y < room.interior.y + room.interior.h; y++) {
      for (let x = room.interior.x; x < room.interior.x + room.interior.w; x++) {
        if (!ctx.blocked.has(`${x},${y}`)) n++
      }
    }
    return n
  }
  const budget = Math.floor(interiorArea * template.density)
  const placedCounts = new Map<string, number>()
  let placedTiles = interiorArea - freeTiles()
  const baseline = placedTiles

  const candidates = template.optional
    .map((e) => ({ entry: e, m: e.id ? manifest(ctx.theme, e.id) : pickByCategory(ctx, e.category) }))
    .filter((c): c is { entry: (typeof template.optional)[0]; m: AtvFurnitureManifest } => !!c.m)

  let attempts = 0
  while (placedTiles - baseline < budget && attempts < 40 && candidates.length > 0) {
    attempts++
    const choice = ctx.rng.pickWeighted(candidates, (c) => c.entry.weight)
    if (!choice) break
    const max = choice.entry.max ?? 2
    if ((placedCounts.get(choice.m.id) ?? 0) >= max) continue
    if (choice.m.canPlaceOnWalls) {
      if (placeOnWall(ctx, room, choice.m)) placedCounts.set(choice.m.id, (placedCounts.get(choice.m.id) ?? 0) + 1)
      continue
    }
    // Realistic placement: free-standing decor hugs the walls (bookshelves,
    // racks, lamps, bins along the perimeter), leaving the room body to the
    // desks. Perimeter candidates are tried first; only when the perimeter
    // is full does an item land in the interior.
    const spots: Array<{ x: number; y: number }> = []
    const maxX = room.interior.x + room.interior.w - choice.m.footprintW
    const maxY = room.interior.y + room.interior.h - choice.m.footprintH
    for (let sx = room.interior.x; sx <= maxX; sx++) {
      spots.push({ x: sx, y: room.interior.y }, { x: sx, y: maxY })
    }
    for (let sy = room.interior.y; sy <= maxY; sy++) {
      spots.push({ x: room.interior.x, y: sy }, { x: maxX, y: sy })
    }
    const shuffled = ctx.rng.shuffle(spots)
    // One seeded interior fallback at the end.
    shuffled.push({
      x: room.interior.x + ctx.rng.nextInt(Math.max(1, room.interior.w - choice.m.footprintW + 1)),
      y: room.interior.y + ctx.rng.nextInt(Math.max(1, room.interior.h - choice.m.footprintH + 1)),
    })
    const spot = shuffled.find(
      (c) =>
        isFree(ctx, room, choice.m, c.x, c.y, ctx.layout.seats) &&
        !room.doorTiles.some((d) => Math.abs(d.x - c.x) <= 1 && Math.abs(d.y - c.y) <= 1),
    )
    if (!spot) continue
    const x = spot.x
    const y = spot.y
    const placed = place(ctx, room, choice.m, x, y)
    // Roll back any placement that breaks reachability.
    if (validateLayout(ctx.layout, ctx.blocked).length > 0) {
      ctx.layout.furniture.splice(ctx.layout.furniture.indexOf(placed), 1)
      for (const t of footprintTiles(choice.m, x, y)) ctx.blocked.delete(`${t.x},${t.y}`)
      continue
    }
    placedCounts.set(choice.m.id, (placedCounts.get(choice.m.id) ?? 0) + 1)
    placedTiles += choice.m.footprintW * choice.m.footprintH
  }
}

function pickByCategory(ctx: DressContext, category?: string): AtvFurnitureManifest | undefined {
  if (!category) return undefined
  const pool = [...ctx.theme.furniture.values()]
    .filter((m) => m.category === category && !(m.seatTiles?.length) && !m.canPlaceOnSurfaces)
    .sort((a, b) => a.id.localeCompare(b.id))
  return ctx.rng.pick(pool)
}

/** Dress every placed room from its zone template. Mutates the layout. */
export function dressRooms(
  layout: OfficeLayout,
  specs: Map<string, RoomSpec>,
  theme: GenTheme,
  rng: AtvRng,
): Set<string> {
  const ctx: DressContext = { layout, theme, rng, blocked: new Set() }
  layout.wallId = theme.walls.length > 0 ? [...theme.walls].sort()[0] : null
  // Corridor tiles get their own floor (from the corridor template) so
  // hallways never share a room's flooring.
  const corridorFloor = theme.dressing.get('corridor')?.floor
  layout.corridorFloorId =
    corridorFloor && theme.floors.includes(corridorFloor) ? corridorFloor : ([...theme.floors].sort()[0] ?? null)

  for (const room of layout.rooms) {
    const template = theme.dressing.get(room.zone)
    room.floorId =
      template?.floor && theme.floors.includes(template.floor)
        ? template.floor
        : ([...theme.floors].sort()[0] ?? null)
    if (!template) continue
    const spec = specs.get(room.id)
    if (room.zone === 'department' && spec) {
      dressClusterRoom(ctx, room, spec, template)
    } else {
      // The manager suite's seat is the synthetic manager's ('manager');
      // executive-wing offices (manager zone, with a lead) seat that
      // executive at a 'head' desk.
      const isExecOffice = room.zone === 'manager' && spec?.lead != null
      dressCountRoom(ctx, room, template, isExecOffice ? 'head' : room.zone === 'manager' ? 'manager' : null)
    }
    // Wall-mounted required items with counts also apply to cluster rooms.
    if (room.zone === 'department') {
      for (const entry of template.required) {
        if (!entry.wallItem) continue
        const m = entry.id ? manifest(theme, entry.id) : pickWallItem(ctx, entry.category)
        if (m) placeOnWall(ctx, room, m)
      }
    }
    dressOptional(ctx, room, template)
  }

  // Pet spawns in the break room (fallback: first corridor tile).
  const breakRoom = layout.rooms.find((r) => r.zone === 'break')
  if (breakRoom) {
    const walkable = buildWalkability(layout, ctx.blocked)
    outer: for (let y = breakRoom.interior.y; y < breakRoom.interior.y + breakRoom.interior.h; y++) {
      for (let x = breakRoom.interior.x; x < breakRoom.interior.x + breakRoom.interior.w; x++) {
        if (walkable[y * layout.width + x]) {
          layout.petSpawn = { x, y }
          break outer
        }
      }
    }
  }
  if (!layout.petSpawn) layout.petSpawn = corridorStart(layout)
  return ctx.blocked
}

function pickWallItem(ctx: DressContext, category?: string): AtvFurnitureManifest | undefined {
  const pool = [...ctx.theme.furniture.values()]
    .filter((m) => m.canPlaceOnWalls && (!category || m.category === category))
    .sort((a, b) => a.id.localeCompare(b.id))
  return ctx.rng.pick(pool)
}
