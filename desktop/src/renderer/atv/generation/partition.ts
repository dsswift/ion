/**
 * Stage 2 — placement: rooms arranged in two bands along a central corridor
 * spine, every room with a door onto the corridor. Deterministic: rooms are
 * assigned greedily (in program order) to whichever band is currently
 * narrower; door positions come from the seeded RNG.
 *
 * Rooms that would push the grid past MAX_GRID are dropped from placement —
 * their agents fall back to the break room (the engine treats agents without
 * seats as hot-desk overflow). The office stays valid rather than failing.
 */
import type { AtvRng } from './prng'
import { INNER_OFFICE, type RoomSpec } from './program'
import { Cell, MAX_GRID, type OfficeLayout, type Rect, type Room, type Point } from './types'

export interface PartitionResult {
  layout: OfficeLayout
  rooms: Map<string, Room>
  /** Room ids from the program that could not be placed (grid cap). */
  dropped: string[]
}

const CORRIDOR_H = 2

export type OfficeOrientation = 'horizontal' | 'vertical'

export function partition(
  seed: string,
  specs: RoomSpec[],
  rng: AtvRng,
  orientation: OfficeOrientation = 'horizontal',
): PartitionResult {
  // Multi-hall layout by DEFAULT: rooms fill a horizontal hallway spine two
  // bands deep, wrapping onto a new spine below once the seeded target width
  // fills — so any office with more than a handful of rooms reads as several
  // hallways, not one strip. A vertical hallway at a seeded x connects the
  // spines; rooms flow around its reserved column.
  const totalExtW = specs.reduce((sum, r) => sum + r.interiorW + 2, 0)
  // Orientation flag: desktops read wide (width >= height), so horizontal —
  // the default — picks the spine count whose estimated footprint stays
  // landscape. Vertical (a portrait mobile client) inverts the preference.
  // Spine height estimate: two bands of typical rooms around the corridor.
  const EST_SPINE_H = 26
  const estWrap = (s: number): number =>
    Math.max(20, Math.min(56, Math.ceil(totalExtW / (s * 2)) + 4))
  const candidates = Math.min(3, Math.max(1, Math.floor(specs.length / 5)))
  let desiredSpines = 1
  if (orientation === 'horizontal') {
    for (let s = candidates; s >= 1; s--) {
      if (estWrap(s) >= s * EST_SPINE_H) {
        desiredSpines = s
        break
      }
    }
  } else {
    desiredSpines = candidates
    for (let s = 1; s <= candidates; s++) {
      if (estWrap(s) <= s * EST_SPINE_H) {
        desiredSpines = s
        break
      }
    }
  }
  const SPINE_WRAP_W = Math.max(
    20,
    Math.min(56, Math.ceil(totalExtW / (desiredSpines * 2)) + 4 + rng.nextInt(6)),
  )
  const VERT_W = 2
  // Reserved vertical-hallway column (skipped by room placement).
  const connectorX = 6 + rng.nextInt(Math.max(1, SPINE_WRAP_W - 14))
  interface Placed {
    spec: RoomSpec
    spine: number
    band: 'top' | 'bottom'
    x: number
    extW: number
    extH: number
  }
  const placed: Placed[] = []
  const dropped: string[] = []
  let spine = 0
  let topW = 0
  let bottomW = 0
  /** Advance past the reserved connector column when a room would straddle it. */
  const skipConnector = (x: number, extW: number): number =>
    x < connectorX + VERT_W && x + extW > connectorX ? connectorX + VERT_W : x
  // Wing separation: rooms sharing a wing name (executive, consultants,
  // any atv-wing value) occupy their OWN hallway — a fresh spine starts at
  // every wing transition, so each named wing reads as its own corridor.
  const wingCount = new Set(specs.map((r) => r.wing ?? '')).size
  let prevWing: string | null = null
  for (const spec of specs) {
    const wing = spec.wing ?? ''
    if (wingCount > 1 && prevWing !== null && wing !== prevWing && placed.length > 0) {
      spine++
      topW = 0
      bottomW = 0
    }
    prevWing = wing
    const extW = spec.interiorW + 2
    const extH = spec.interiorH + 2
    let band: 'top' | 'bottom' = topW <= bottomW ? 'top' : 'bottom'
    let x = skipConnector(Math.max(VERT_W, band === 'top' ? topW : bottomW), extW)
    if (x + extW > SPINE_WRAP_W + VERT_W) {
      const other: 'top' | 'bottom' = band === 'top' ? 'bottom' : 'top'
      const otherX = skipConnector(other === 'top' ? topW : bottomW, extW)
      if (otherX + extW <= SPINE_WRAP_W + VERT_W) {
        band = other
        x = otherX
      } else if (extW <= SPINE_WRAP_W) {
        // Wrap to a fresh spine below.
        spine++
        topW = 0
        bottomW = 0
        band = 'top'
        x = skipConnector(VERT_W, extW)
      } else {
        dropped.push(spec.id)
        continue
      }
    }
    placed.push({ spec, spine, band, x, extW, extH })
    if (band === 'top') topW = x + extW
    else bottomW = x + extW
  }

  // Vertical extents per spine: top band height + corridor + bottom band.
  const spineCount = spine + 1
  const spineTopH: number[] = []
  const spineBottomH: number[] = []
  for (let i = 0; i < spineCount; i++) {
    spineTopH.push(Math.max(0, ...placed.filter((p) => p.spine === i && p.band === 'top').map((p) => p.extH)))
    spineBottomH.push(Math.max(0, ...placed.filter((p) => p.spine === i && p.band === 'bottom').map((p) => p.extH)))
  }
  const spineY: number[] = [] // corridor y per spine
  let cursorY = 0
  for (let i = 0; i < spineCount; i++) {
    spineY.push(cursorY + spineTopH[i])
    cursorY += spineTopH[i] + CORRIDOR_H + spineBottomH[i]
  }
  // Ring-corridor width: the widest spine plus the RIGHT vertical hallway
  // column. Every spine corridor spans the full building width so both ends
  // land on vertical hallways — a continuous loop, never a dead end.
  const width = Math.min(
    MAX_GRID,
    Math.max(
      8 + VERT_W,
      spineCount > 1 ? connectorX + VERT_W * 2 : 0,
      ...placed.map((p) => p.x + p.extW + VERT_W),
    ),
  )
  const height = Math.min(MAX_GRID, cursorY)

  const cells = new Array<Cell>(width * height).fill(Cell.Void)
  const put = (x: number, y: number, cell: Cell) => {
    if (x >= 0 && y >= 0 && x < width && y < height) cells[y * width + x] = cell
  }

  // Continuous hallway loop: every spine corridor spans the FULL building
  // width, and vertical hallways at the left edge, right edge, and the
  // seeded mid-building column tie the spines together. No horizontal
  // hallway dead-ends; the mid column is the interior shortcut so walking
  // between rows never requires the full perimeter.
  for (let i = 0; i < spineCount; i++) {
    for (let y = spineY[i]; y < spineY[i] + CORRIDOR_H; y++) {
      for (let x = 0; x < width; x++) put(x, y, Cell.Floor)
    }
  }
  if (spineCount > 1) {
    const columns = [0, connectorX, width - VERT_W]
    for (const colX of columns) {
      for (let y = spineY[0]; y < spineY[spineCount - 1] + CORRIDOR_H; y++) {
        for (let x = colX; x < colX + VERT_W; x++) put(x, y, Cell.Floor)
      }
    }
  }

  const rooms = new Map<string, Room>()
  for (const p of placed) {
    // Bottom-align top-band rooms to their spine corridor; top-align bottom-band rooms.
    const y = p.band === 'top' ? spineY[p.spine] - p.extH : spineY[p.spine] + CORRIDOR_H
    const rect = { x: p.x, y, w: p.extW, h: p.extH }
    const interior = { x: rect.x + 1, y: rect.y + 1, w: p.extW - 2, h: p.extH - 2 }
    // Walls first, then carve the interior.
    for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
      for (let xx = rect.x; xx < rect.x + rect.w; xx++) put(xx, yy, Cell.Wall)
    }
    for (let yy = interior.y; yy < interior.y + interior.h; yy++) {
      for (let xx = interior.x; xx < interior.x + interior.w; xx++) put(xx, yy, Cell.Floor)
    }

    // The lead's inner office pocket, carved into a corner on the wall
    // OPPOSITE the corridor door so it can never seal the room entrance.
    // Seeded corner (left/right) is part of the procedural variation.
    let innerOffice: Room['innerOffice'] = null
    if (p.spec.zone === 'department' && p.spec.lead && !p.spec.leadInWing) {
      const left = rng.nextInt(2) === 0
      const innerX = left ? rect.x : rect.x + rect.w - INNER_OFFICE.w
      const innerY = p.band === 'top' ? rect.y : rect.y + rect.h - INNER_OFFICE.h
      const innerRect: Rect = { x: innerX, y: innerY, w: INNER_OFFICE.w, h: INNER_OFFICE.h }
      for (let yy = innerRect.y; yy < innerRect.y + innerRect.h; yy++) {
        for (let xx = innerRect.x; xx < innerRect.x + innerRect.w; xx++) put(xx, yy, Cell.Wall)
      }
      const innerInterior: Rect = {
        x: innerRect.x + 1,
        y: innerRect.y + 1,
        w: INNER_OFFICE.w - 2,
        h: INNER_OFFICE.h - 2,
      }
      for (let yy = innerInterior.y; yy < innerInterior.y + innerInterior.h; yy++) {
        for (let xx = innerInterior.x; xx < innerInterior.x + innerInterior.w; xx++) put(xx, yy, Cell.Floor)
      }
      // The pocket's door opens into the room body: bottom wall for top-band
      // rooms, top wall for bottom-band rooms, seeded x within the pocket.
      const doorInnerX = innerInterior.x + rng.nextInt(innerInterior.w)
      const doorInnerY = p.band === 'top' ? innerRect.y + innerRect.h - 1 : innerRect.y
      put(doorInnerX, doorInnerY, Cell.Door)
      const door: Point = { x: doorInnerX, y: doorInnerY }
      innerOffice = { rect: innerRect, interior: innerInterior, door }
    }

    // Door on the corridor-facing wall, seeded position within the interior
    // span, never under the inner office pocket.
    const doorCandidates: number[] = []
    for (let x = interior.x; x < interior.x + interior.w; x++) {
      if (innerOffice && x >= innerOffice.rect.x && x < innerOffice.rect.x + innerOffice.rect.w) continue
      doorCandidates.push(x)
    }
    const doorX = doorCandidates[rng.nextInt(doorCandidates.length)] ?? interior.x
    const doorY = p.band === 'top' ? rect.y + rect.h - 1 : rect.y
    put(doorX, doorY, Cell.Door)

    rooms.set(p.spec.id, {
      id: p.spec.id,
      zone: p.spec.zone,
      rect,
      interior,
      doorTiles: [{ x: doorX, y: doorY }],
      floorId: null,
      leadAgent: p.spec.lead?.name ?? null,
      accent: p.spec.accent,
      innerOffice,
    })
  }

  const layout: OfficeLayout = {
    seed,
    width,
    height,
    cells,
    rooms: [...rooms.values()],
    furniture: [],
    seats: [],
    restTiles: [],
    petSpawn: null,
    wallId: null,
    corridorFloorId: null,
  }
  return { layout, rooms, dropped }
}
