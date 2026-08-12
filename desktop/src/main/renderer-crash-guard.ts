// renderer-crash-guard.ts — bounded automatic recovery for a dead renderer.
//
// A renderer crash (V8 OOM, GPU fault, kill) does NOT destroy its
// BrowserWindow: the window object stays alive with dead webContents. For the
// overlay that is the worst possible failure shape — a transparent,
// click-blocking, permanently empty window over the whole desktop, with a
// working tray beside it. `ensureWindow()` never fires because the window is
// not destroyed, and before this file existed the `render-process-gone`
// handlers only logged, so the app ran headless until a manual relaunch. That
// happened twice in production in one day (30.7 MB agent roster → renderer
// V8 OOM, SIGTRAP exit code 5).
//
// Recovery is a reload of the surviving window (or a recreate when the window
// itself is gone), bounded by a crash-loop budget: a renderer that dies
// instantly on every boot — corrupt persisted state, a crashing extension
// surface — must not reload in a hot loop forever. When the budget is spent
// the guard stops, tells the operator, and leaves the tray alive; a manual
// show resets the budget so the operator can always retry by hand.

import { Notification } from 'electron'
import { log, warn, error } from './logger'

type WindowKind = 'overlay' | 'atv'

/** Max automatic recoveries per rolling window, per window kind. */
const MAX_RECOVERIES = 3
/** Rolling window for the budget. */
const BUDGET_WINDOW_MS = 5 * 60 * 1000

interface GuardState {
  /** Recovery timestamps inside the rolling window. */
  attempts: number[]
  /** Budget spent — no further automatic recovery until a reset. */
  exhausted: boolean
}

const guards = new Map<WindowKind, GuardState>()

function guardFor(kind: WindowKind): GuardState {
  let g = guards.get(kind)
  if (!g) {
    g = { attempts: [], exhausted: false }
    guards.set(kind, g)
  }
  return g
}

/**
 * Attempt one bounded recovery of a crashed renderer.
 *
 * `recover` is supplied by the window manager that owns the window — the
 * guard owns the budget and the operator signal, not the window mechanics.
 * Returns true when the recovery ran, false when the budget refused it.
 */
export function attemptRendererRecovery(
  kind: WindowKind,
  details: { reason: string; exitCode: number },
  recover: () => void,
): boolean {
  const g = guardFor(kind)
  const now = Date.now()
  g.attempts = g.attempts.filter((t) => now - t < BUDGET_WINDOW_MS)

  if (g.exhausted || g.attempts.length >= MAX_RECOVERIES) {
    if (!g.exhausted) {
      g.exhausted = true
      error('crash-guard', 'renderer crash loop: recovery budget exhausted, giving up', {
        kind, reason: details.reason, exit_code: details.exitCode,
        attempts: g.attempts.length, window_ms: BUDGET_WINDOW_MS,
      })
      notifyOperator(kind)
    } else {
      warn('crash-guard', 'renderer crashed again while recovery is exhausted', {
        kind, reason: details.reason, exit_code: details.exitCode,
      })
    }
    return false
  }

  g.attempts.push(now)
  log('crash-guard', 'renderer crashed: attempting automatic recovery', {
    kind, reason: details.reason, exit_code: details.exitCode,
    attempt: g.attempts.length, budget: MAX_RECOVERIES,
  })
  try {
    recover()
    log('crash-guard', 'renderer recovery initiated', { kind, attempt: g.attempts.length })
    return true
  } catch (err) {
    error('crash-guard', 'renderer recovery threw', { kind, error: String(err) })
    return false
  }
}

/**
 * Reset a window kind's budget. Called from the MANUAL show paths (tray,
 * shortcut): an operator explicitly summoning the window is consent to try
 * again, and it must always work even after the automatic budget is spent.
 */
export function resetRendererCrashGuard(kind: WindowKind): void {
  const g = guards.get(kind)
  if (!g) return
  if (g.exhausted || g.attempts.length > 0) {
    log('crash-guard', 'crash-recovery budget reset by manual show', { kind })
  }
  g.attempts = []
  g.exhausted = false
}

function notifyOperator(kind: WindowKind): void {
  if (!Notification.isSupported()) return
  const surface = kind === 'overlay' ? 'overlay' : 'ATV window'
  new Notification({
    title: 'Ion',
    body: `The Ion ${surface} crashed repeatedly and automatic recovery stopped. Use the tray icon to reopen it.`,
  }).show()
}

/** Test hook: clear all budgets. */
export function __resetCrashGuardForTest(): void {
  guards.clear()
}
