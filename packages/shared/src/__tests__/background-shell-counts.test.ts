// @vitest-environment node
/**
 * Regression coverage for the detached-background-command defect.
 *
 * REPORTED: a conversation ran `Bash({ run_in_background: true })` WITHOUT
 * `notify_on_complete`. The command ran 96 seconds. For that entire time the
 * pink Bash operation group correctly showed it running, while every other
 * surface said the conversation was finished: the composer badge was absent,
 * the tab dot was green/complete, the tab auto-moved to the Done group, and
 * the inbox filed the conversation as done.
 *
 * ROOT CAUSE: the engine publishes two different shell numbers.
 * `statusFields.backgroundShells` counts only commands the engine PARKS the
 * session on (`notify_on_complete`), and `hasPendingWork` is true only for that
 * same set. `statusFields.activeBackgroundTasks` is the complete snapshot of
 * every LIVE session-owned Bash process. Every desktop "is work in flight?"
 * fold read the notify-only scalar, so a detached command was invisible to all
 * of them.
 *
 * These tests pin the FOLDS, which is the stable seam: each one is the single
 * definition consumed by a user-visible surface (composer badge, tab dot, close
 * guard, Done-group move, auto-settle, inbox partition, iOS projection).
 */

import { describe, it, expect } from 'vitest'
import { liveBackgroundShellCount, heldBackgroundShellCount } from '../background-shell-counts'

/** The exact status snapshot the engine emitted for the reported task. */
const DETACHED_ONLY = {
  backgroundShells: 0,
  hasPendingWork: false,
  activeBackgroundTasks: [
    { taskId: 'bash-1-1787439682814', command: 'sleep 96', startedAt: 1787439682814, notifyOnComplete: false },
  ],
} as const

describe('liveBackgroundShellCount', () => {
  it('counts a detached command the engine is NOT parked on (REGRESSION)', () => {
    // Pre-fix every consumer read `backgroundShells` and got 0 here.
    expect(liveBackgroundShellCount(DETACHED_ONLY)).toBe(1)
  })

  it('counts a notifying command', () => {
    expect(liveBackgroundShellCount({
      backgroundShells: 1,
      activeBackgroundTasks: [{ taskId: 'a', command: 'c', startedAt: 1, notifyOnComplete: true }],
    })).toBe(1)
  })

  it('does not double-count: both fields observe the same processes', () => {
    // Two live tasks, one of which notifies. Summing would report 3.
    expect(liveBackgroundShellCount({
      backgroundShells: 1,
      activeBackgroundTasks: [
        { taskId: 'a', command: 'c', startedAt: 1, notifyOnComplete: true },
        { taskId: 'b', command: 'd', startedAt: 2, notifyOnComplete: false },
      ],
    })).toBe(2)
  })

  it('falls back to the scalar when the task list is absent', () => {
    // The engine's maxOutstanding cap can hold a notifying command without a
    // registry row, and a pre-activeBackgroundTasks engine sends only the
    // scalar. Trusting the list alone would report 0 for real work.
    expect(liveBackgroundShellCount({ backgroundShells: 2 })).toBe(2)
  })

  it('is 0 for an idle session', () => {
    expect(liveBackgroundShellCount({ backgroundShells: 0, activeBackgroundTasks: [] })).toBe(0)
    expect(liveBackgroundShellCount(null)).toBe(0)
    expect(liveBackgroundShellCount(undefined)).toBe(0)
  })
})

describe('heldBackgroundShellCount', () => {
  it('reports 0 for a detached command — the engine is not waiting on it', () => {
    // This is what keeps the "waiting for N background shells" wording honest.
    // The badge must APPEAR (live count > 0) while the label must not claim a
    // wait that is not happening.
    expect(heldBackgroundShellCount(DETACHED_ONLY)).toBe(0)
  })

  it('reports the parked count for a notifying command', () => {
    expect(heldBackgroundShellCount({
      backgroundShells: 2,
      activeBackgroundTasks: [
        { taskId: 'a', command: 'c', startedAt: 1, notifyOnComplete: true },
        { taskId: 'b', command: 'd', startedAt: 2, notifyOnComplete: true },
      ],
    })).toBe(2)
  })
})
