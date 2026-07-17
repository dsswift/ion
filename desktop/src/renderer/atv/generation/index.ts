/**
 * generateOffice — the deterministic generation pipeline.
 *
 * Contract (pinned by determinism.test.ts): same seed + same roster + same
 * theme data ⇒ byte-identical OfficeLayout. All randomness flows through the
 * seeded PRNG; independent stages draw from derived child streams so a change
 * in one stage's consumption never shifts another.
 *
 * Regeneration policy lives with the caller: regenerate only on seed change
 * or tab switch — never on mid-run roster growth (overflow agents hot-desk).
 */
import { createRng, deriveSeed } from './prng'
import { buildProgram, type RoomSpec } from './program'
import { partition, type OfficeOrientation } from './partition'
import { dressRooms } from './dressing'
import { assignSeats } from './seating'
import { validateLayout } from './validate'
import type { GenTheme, OfficeLayout, Roster } from './types'

export interface GenerateResult {
  layout: OfficeLayout
  /** Furniture-blocked tiles for the walkability grid (`x,y` keys). */
  blocked: Set<string>
  /** Invariant violations (always empty for a healthy pack; surfaced, not thrown). */
  errors: string[]
  /** Room ids the grid cap forced out (their agents hot-desk). */
  droppedRooms: string[]
}

export function generateOffice(
  seed: string,
  roster: Roster,
  theme: GenTheme,
  options: { orientation?: OfficeOrientation } = {},
): GenerateResult {
  const specs = buildProgram(roster)
  const specMap = new Map<string, RoomSpec>(specs.map((s) => [s.id, s]))

  const layoutRng = createRng(deriveSeed(seed, 'layout'))
  const { layout, dropped } = partition(seed, specs, layoutRng, options.orientation ?? 'horizontal')

  const dressingRng = createRng(deriveSeed(seed, 'dressing'))
  const blocked = dressRooms(layout, specMap, theme, dressingRng)

  assignSeats(layout, roster)

  const errors = validateLayout(layout, blocked)
  return { layout, blocked, errors, droppedRooms: dropped }
}

/** Serialize a layout for the byte-identical determinism contract. */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout)
}

export { deriveRoster, allRosterAgents } from './roster'
export { seatOf, managerSeat } from './seating'
export * from './types'
