/**
 * inbox-snooze-presets — the snooze duration menu (t3 semantics, Ion
 * idioms): In 1 hour / In 3 hours / This evening 18:00 / Tomorrow 09:00 /
 * Next Monday 09:00, with past/near presets suppressed.
 */

export interface SnoozePreset {
  id: string
  label: string
  /** Wake time for a snooze started at `now` (ms). */
  wakeAt: (now: Date) => number
}

const HOUR = 60 * 60 * 1000

/** Suppress presets waking less than this far ahead (near-noop snoozes). */
const MIN_LEAD_MS = 20 * 60 * 1000

function at(base: Date, dayOffset: number, hour: number): number {
  const d = new Date(base)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { id: 'hour', label: 'In 1 hour', wakeAt: (now) => now.getTime() + HOUR },
  { id: 'three-hours', label: 'In 3 hours', wakeAt: (now) => now.getTime() + 3 * HOUR },
  { id: 'evening', label: 'This evening (18:00)', wakeAt: (now) => at(now, 0, 18) },
  { id: 'tomorrow', label: 'Tomorrow (09:00)', wakeAt: (now) => at(now, 1, 9) },
  {
    id: 'monday',
    label: 'Next Monday (09:00)',
    wakeAt: (now) => {
      const day = now.getDay() // 0 Sun .. 6 Sat
      const daysUntilMonday = ((8 - day) % 7) || 7
      return at(now, daysUntilMonday, 9)
    },
  },
]

/** The presets worth showing right now (past/near-future suppressed). */
export function availableSnoozePresets(now: Date): Array<{ id: string; label: string; until: number }> {
  return SNOOZE_PRESETS.map((p) => ({ id: p.id, label: p.label, until: p.wakeAt(now) })).filter(
    (p) => p.until - now.getTime() >= MIN_LEAD_MS,
  )
}
