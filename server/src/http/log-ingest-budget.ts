/**
 * A per-caller ceiling on forwarded browser log lines.
 *
 * `POST /log` writes into the same `server.jsonl` the server's own
 * diagnostics go to, and the caller chooses the tag and the message. The
 * logger's shared rate limiter keys on `(level, tag, msg)` and deliberately
 * never limits ERROR -- correct for the server's own lines, and an open door
 * here: a browser sending distinct messages, or any message at ERROR, could
 * write without bound and rotate the window that holds the evidence of it
 * doing so.
 *
 * So the budget is per authenticated subject, counts every level, and is
 * applied before the line reaches the logger at all.
 */

/** Lines one subject may forward per window. Generous for real client logging, far below what it takes to rotate the file. */
const LINES_PER_WINDOW = 200
const WINDOW_MS = 10_000
/**
 * Subjects tracked at once. A bound on this map matters as much as the
 * per-subject one: the keys are authenticated subjects rather than arbitrary
 * client strings, but a server with many signed-in browsers should not grow
 * an entry per subject forever.
 */
const MAX_TRACKED_SUBJECTS = 1_000

interface Window {
  startedMs: number
  count: number
  /** Lines refused since the window opened, reported once when it closes. */
  dropped: number
}

const windows = new Map<string, Window>()

export interface BudgetDecision {
  /** Whether this line may be written. */
  allow: boolean
  /** Set on the first refusal of a window, and when a window with refusals closes: how many were dropped. */
  dropped?: number
}

/**
 * Charge one line against a subject's budget.
 *
 * Returns `dropped` exactly once per window that refused anything -- on the
 * refusal that crosses the limit, and again when a later window rolls over
 * with a total -- so a flood is reported without the report itself becoming
 * the flood.
 */
export function admitWebLine(subject: string, nowMs: number): BudgetDecision {
  const existing = windows.get(subject)

  if (!existing || nowMs - existing.startedMs >= WINDOW_MS) {
    const dropped = existing?.dropped ?? 0
    windows.set(subject, { startedMs: nowMs, count: 1, dropped: 0 })
    evictIdle(nowMs)
    return dropped > 0 ? { allow: true, dropped } : { allow: true }
  }

  if (existing.count < LINES_PER_WINDOW) {
    existing.count += 1
    return { allow: true }
  }

  existing.dropped += 1
  // Only the crossing refusal reports; the rest are counted for the summary
  // the next window carries.
  return existing.dropped === 1 ? { allow: false, dropped: 1 } : { allow: false }
}

/** Forget windows that closed long ago, keeping the map bounded. */
function evictIdle(nowMs: number): void {
  if (windows.size <= MAX_TRACKED_SUBJECTS) return
  for (const [subject, window] of windows) {
    if (nowMs - window.startedMs >= WINDOW_MS * 2) windows.delete(subject)
  }
}

/** TEST ONLY. */
export function _resetBudgetForTest(): void {
  windows.clear()
}

/** TEST ONLY: the constants the route's behaviour is pinned against. */
export const _budgetLimitsForTest = { LINES_PER_WINDOW, WINDOW_MS }
