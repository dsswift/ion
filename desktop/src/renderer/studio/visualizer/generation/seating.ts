/**
 * Stage 4 — seat assignment. Stable by sorted agent name: the same roster
 * always sits in the same seats, regardless of the order agents arrived in
 * the snapshot. Roster growth mid-run never regenerates the office — new
 * agents beyond seat capacity are simply unassigned here and treated as
 * hot-desk overflow by the simulation (they hang out in the break room).
 */
import type { OfficeLayout, Roster, Seat } from './types'

function clusterSeatsOf(layout: OfficeLayout, roomId: string): Seat[] {
  return layout.seats
    .filter((s) => s.roomId === roomId && s.kind === 'cluster')
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
}

/** Assign roster agents to the layout's seats. Mutates seat.agent. */
export function assignSeats(layout: OfficeLayout, roster: Roster): void {
  // Executives sit at the head desk of their private wing office.
  for (const exec of roster.executives) {
    const seat = layout.seats.find((s) => s.roomId === `exec-${exec.name}` && s.kind === 'head')
    if (seat) seat.agent = exec.name
  }
  for (const dept of roster.departments) {
    const roomId = `dept-${dept.lead.name}`
    const head = layout.seats.find((s) => s.roomId === roomId && s.kind === 'head')
    if (head) head.agent = dept.lead.name
    const seats = clusterSeatsOf(layout, roomId)
    const specialists = [...dept.specialists].sort((a, b) => a.name.localeCompare(b.name))
    for (let i = 0; i < specialists.length && i < seats.length; i++) {
      seats[i].agent = specialists[i].name
    }
  }
  // Solo staff sit at the head desk of their own private office.
  for (const solo of roster.solo) {
    const seat = layout.seats.find((s) => s.roomId === `office-${solo.name}` && s.kind === 'head')
    if (seat) seat.agent = solo.name
  }
}

/** The seat assigned to an agent, if any (overflow agents have none). */
export function seatOf(layout: OfficeLayout, agentName: string): Seat | undefined {
  return layout.seats.find((s) => s.agent === agentName)
}

/** The manager's seat (synthetic manager character, always present). */
export function managerSeat(layout: OfficeLayout): Seat | undefined {
  return layout.seats.find((s) => s.kind === 'manager')
}
