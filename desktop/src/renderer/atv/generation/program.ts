/**
 * Stage 1 — room program: which rooms the office needs and how big each one
 * is, derived from the roster. Sizes are in interior floor tiles; partition
 * adds the walls.
 */
import type { AtvZone } from '../../../shared/types-atv'
import type { Roster, RosterAgent } from './types'

export interface RoomSpec {
  id: string
  zone: AtvZone
  interiorW: number
  interiorH: number
  lead: RosterAgent | null
  /** Agents seated at this room's desk cluster (excludes the lead). */
  clusterAgents: RosterAgent[]
  /** Unassigned guest desks placed after the cluster (seat kind 'hot'). */
  spareSeats: number
  /** Named hallway wing: rooms sharing a wing name cluster on their own hallway. */
  wing?: string
  /** Department whose lead sits in the wing: no corner office is carved. */
  leadInWing?: boolean
  accent: string | null
}

/** Guest desks in the remote-work office (every office has a few spares). */
export const REMOTE_OFFICE_SPARE_SEATS = 4

/** Desk-cluster geometry shared by program sizing and dressing placement. */
export const CLUSTER = {
  /** Desks per row. */
  columns: 3,
  /** Tiles per desk column (desk width 2 + 1 aisle). */
  columnPitch: 3,
  /** Tiles per cluster row (desk + chair + aisle). */
  rowPitch: 3,
}

export function clusterRows(seatCount: number): number {
  return Math.ceil(seatCount / CLUSTER.columns)
}

/**
 * The lead's private inner office, carved into a corner of the department
 * room (sharing the room's outer walls). Exterior tiles including its own
 * walls; the interior is a 4x2 floor pocket holding the lead's desk group.
 */
export const INNER_OFFICE = {
  /** Exterior width in tiles (shares the room's side wall). */
  w: 6,
  /** Exterior height in tiles (shares the room's top/bottom wall). */
  h: 4,
}

function clusterInterior(seatCount: number, hasInnerOffice: boolean): { w: number; h: number } {
  const cols = Math.max(1, Math.min(seatCount, CLUSTER.columns))
  const rows = clusterRows(Math.max(1, seatCount))
  const w = Math.max(cols * CLUSTER.columnPitch + 1, hasInnerOffice ? INNER_OFFICE.w + 3 : 8)
  // Inner-office rooms: 3 interior rows for the inner pocket (its far wall is
  // the room's outer wall) + 1 clearance row below its door + cluster rows +
  // 1 circulation row on the corridor-door side.
  const h = hasInnerOffice
    ? 3 + 1 + rows * CLUSTER.rowPitch + 1
    : Math.max(rows * CLUSTER.rowPitch + 2, 5)
  return { w, h }
}

/**
 * Compute the room program. Order is the deterministic placement order:
 * manager, mail, break, departments (by lead name), bullpen.
 */
export function buildProgram(roster: Roster): RoomSpec[] {
  const rooms: RoomSpec[] = [
    // The CEO's office: when an executive wing exists, the manager sits in
    // it alongside the other executives (partition groups the wing onto its
    // own hallway).
    { id: 'manager', zone: 'manager', interiorW: 8, interiorH: 6, lead: null, clusterAgents: [], spareSeats: 0, wing: 'executive', accent: null },
  ]
  // Executive wing: a private office per executive, immediately after the
  // CEO so the whole wing occupies one contiguous hallway.
  for (const exec of roster.executives) {
    rooms.push({
      id: `exec-${exec.name}`,
      zone: 'manager',
      interiorW: 7,
      interiorH: 5,
      lead: exec,
      clusterAgents: [],
      spareSeats: 0,
      wing: 'executive',
      accent: exec.color,
    })
  }
  rooms.push(
    { id: 'mail', zone: 'mail', interiorW: 6, interiorH: 5, lead: null, clusterAgents: [], spareSeats: 0, accent: null },
    { id: 'break', zone: 'break', interiorW: 8, interiorH: 6, lead: null, clusterAgents: [], spareSeats: 0, accent: null },
  )
  for (const dept of roster.departments) {
    const size = clusterInterior(dept.specialists.length, !dept.leadInWing)
    // A lead's NAMED wing (atv-wing, other than the executive wing) pulls
    // the whole department room onto that wing's hallway.
    const deptWing = dept.lead.wing && dept.lead.wing !== 'executive' ? dept.lead.wing : undefined
    rooms.push({
      id: `dept-${dept.lead.name}`,
      zone: 'department',
      interiorW: size.w,
      interiorH: size.h,
      lead: dept.lead,
      clusterAgents: dept.specialists,
      spareSeats: 0,
      wing: deptWing,
      leadInWing: dept.leadInWing,
      accent: dept.lead.color,
    })
  }
  // Known staff without a parent are not bullpen fodder: each gets an
  // individual private office along the hall, like any senior IC would.
  for (const solo of roster.solo) {
    rooms.push({
      id: `office-${solo.name}`,
      zone: 'manager',
      interiorW: 6,
      interiorH: 4,
      lead: solo,
      clusterAgents: [],
      spareSeats: 0,
      // atv-wing groups staff offices onto a named hallway (e.g. a
      // consultants wing); unwinged staff sit on the general hallways.
      wing: solo.wing && solo.wing !== 'executive' ? solo.wing : undefined,
      accent: solo.color,
    })
  }
  // Meeting rooms: one always; a second when the org is big enough that two
  // teams plausibly meet at once.
  const meetingRooms = roster.departments.length >= 4 ? 2 : 1
  for (let i = 0; i < meetingRooms; i++) {
    rooms.push({
      id: `meeting-${i + 1}`,
      zone: 'meeting',
      interiorW: 7,
      interiorH: 5,
      lead: null,
      clusterAgents: [],
      spareSeats: 0,
      accent: null,
    })
  }
  // Arrivals: the front door. Agents unknown to the roster walk in from
  // here instead of materializing mid-office.
  rooms.push({
    id: 'arrivals',
    zone: 'lobby',
    interiorW: 4,
    interiorH: 3,
    lead: null,
    clusterAgents: [],
    spareSeats: 0,
    accent: null,
  })
  // Remote-work office: always present, all guest desks. Visiting agents
  // with no dedicated workstation (and every agent in a plain conversation)
  // work from here.
  const remoteSize = clusterInterior(REMOTE_OFFICE_SPARE_SEATS, false)
  rooms.push({
    id: 'remote-office',
    zone: 'department',
    interiorW: remoteSize.w,
    interiorH: remoteSize.h,
    lead: null,
    clusterAgents: [],
    spareSeats: REMOTE_OFFICE_SPARE_SEATS,
    accent: null,
  })
  // Wing grouping: the executive wing leads (already first), then every
  // other named wing as a contiguous block (alphabetical by wing name,
  // stable within), then the general hallways. Partition starts a fresh
  // hallway at every wing transition.
  const execRooms = rooms.filter((r) => r.wing === 'executive')
  const namedWings = [...new Set(rooms.filter((r) => r.wing && r.wing !== 'executive').map((r) => r.wing as string))].sort()
  const winged = namedWings.flatMap((w) => rooms.filter((r) => r.wing === w))
  const general = rooms.filter((r) => !r.wing)
  return [...execRooms, ...winged, ...general]
}
