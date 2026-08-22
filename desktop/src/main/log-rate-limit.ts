/**
 * Per-message rate limit for the desktop logger.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A runaway loop in shipped code writes one *message identity* at whatever rate
 * the loop runs. Two of them were found in the same investigation: a
 * render-driven store refresh feeding itself, and a relay token-refresh timer
 * armed at a zero delay. Between them the desktop wrote roughly 2700 lines per
 * second, which rotated all four 20 MB generations of `desktop.jsonl` in about
 * twenty minutes — and took with them the log window that held the evidence of
 * the bug being investigated. The flood did not merely add noise; it destroyed
 * the observability the logging policy exists to guarantee.
 *
 * Both root causes are fixed. This is the backstop, because the next runaway
 * loop is not yet written and it must not be able to erase the record of
 * itself.
 *
 * ── Why the key is (level, tag, msg) and not the whole line ─────────────────
 * Exact-line dedupe would not have caught either flood: both carried a
 * timestamp or a delay in `fields`, so no two lines were byte-identical. What
 * repeats in a runaway loop is the *call site*, and `msg` is its stable
 * identity — `msg` is a constant string by policy (ADR-019 forbids
 * interpolating values into it), which is exactly what makes it usable as a key.
 *
 * ── Why this does not cost observability ────────────────────────────────────
 * The first `PER_WINDOW_LIMIT` occurrences in every window pass through
 * untouched, so the onset of a storm is always fully recorded with its fields.
 * Past that, lines are counted rather than dropped: the count is emitted as a
 * real log line (`decision.suppressed` with `log_suppressed`), so "this call
 * site fired 26,431 times in ten seconds" is *more* legible in the log than
 * 26,431 individual copies of it were. Nothing is silently discarded — which is
 * the requirement in AGENTS.md § "No silent failures".
 *
 * ERROR is never limited. Errors are rare by construction, they are the lines a
 * post-crash investigation needs first, and an ERROR storm is itself the signal.
 */

/** Length of one accounting window. */
const WINDOW_MS = 10 * 1000

/**
 * Lines per message identity per window that pass through verbatim.
 *
 * 50 per 10 s is far above any legitimate call site's steady rate and far below
 * the rate at which a loop threatens rotation.
 */
const PER_WINDOW_LIMIT = 50

/**
 * Cap on tracked identities. Reached only if a call site interpolates values
 * into `msg` (which ADR-019 forbids); the cap keeps that mistake from becoming
 * an unbounded map in the logger.
 */
const MAX_TRACKED_KEYS = 2048

interface WindowState {
  /** Start of the current window, in ms since epoch. */
  windowStart: number
  /** Lines emitted verbatim in the current window. */
  emitted: number
  /** Lines withheld in the current window, reported when the window closes. */
  suppressed: number
}

const windows = new Map<string, WindowState>()

/** A withheld run of one message identity, ready to be reported as one line. */
export interface SuppressionSummary {
  key: string
  count: number
  windowMs: number
}

export interface RateDecision {
  /** Whether the caller should write this line. */
  allow: boolean
  /**
   * A closed window's withheld count, if this call closed one. The caller emits
   * it as its own log line so the withheld run is never silently lost.
   */
  summary?: SuppressionSummary
}

/**
 * Account for one log line and decide whether to write it.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the accounting is
 * testable without fake timers.
 */
export function admitLogLine(
  level: string,
  tag: string,
  msg: string,
  nowMs: number,
): RateDecision {
  if (level === 'ERROR') return { allow: true }

  const key = `${level}|${tag}|${msg}`
  const state = windows.get(key)

  if (state === undefined) {
    if (windows.size >= MAX_TRACKED_KEYS) evictIdle(nowMs)
    windows.set(key, { windowStart: nowMs, emitted: 1, suppressed: 0 })
    return { allow: true }
  }

  if (nowMs - state.windowStart >= WINDOW_MS) {
    // Window closed. Report what it withheld, then open a fresh one — the
    // report rides the first line of the NEXT window so a storm's tail is
    // always accounted for by its own successor.
    const withheld = state.suppressed
    state.windowStart = nowMs
    state.emitted = 1
    state.suppressed = 0
    if (withheld > 0) {
      return { allow: true, summary: { key, count: withheld, windowMs: WINDOW_MS } }
    }
    return { allow: true }
  }

  if (state.emitted < PER_WINDOW_LIMIT) {
    state.emitted++
    return { allow: true }
  }

  state.suppressed++
  return { allow: false }
}

/**
 * Drain every outstanding withheld count.
 *
 * Called from the logger's shutdown flush: a storm that stops just before exit
 * has no successor line to carry its report, and losing the count would be the
 * one case where this limiter did hide something.
 */
export function drainSuppressions(): SuppressionSummary[] {
  const out: SuppressionSummary[] = []
  for (const [key, state] of windows) {
    if (state.suppressed > 0) {
      out.push({ key, count: state.suppressed, windowMs: WINDOW_MS })
      state.suppressed = 0
    }
  }
  return out
}

/**
 * Drop identities whose window closed at least one full window ago. A key with
 * an outstanding withheld count is kept, because dropping it would discard the
 * count the next line is supposed to report.
 */
function evictIdle(nowMs: number): void {
  for (const [key, state] of windows) {
    if (state.suppressed === 0 && nowMs - state.windowStart >= WINDOW_MS * 2) {
      windows.delete(key)
    }
  }
}

/** TEST ONLY. Clear all accounting state between cases. */
export function _resetForTest(): void {
  windows.clear()
}

export { WINDOW_MS, PER_WINDOW_LIMIT, MAX_TRACKED_KEYS }
