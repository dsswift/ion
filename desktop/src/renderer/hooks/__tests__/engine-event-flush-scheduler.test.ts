/**
 * The starved owner — a hidden window must still drain the engine stream.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * The inbound stream queue used to drain from `requestAnimationFrame` alone.
 * Electron stops delivering animation frames to a hidden window, and the
 * Overlay renderer is HIDDEN but still the session-store OWNER while the
 * Studio presentation is active (main/active-ui.ts hides the glass rather than
 * closing it, so runs are uninterrupted).
 *
 * So the owner enqueued every inbound event and scheduled a frame that never
 * arrived. It starved on the whole stream — text deltas, tool results,
 * permission requests, and run completions. Observed live: a conversation whose
 * run had finished stayed 'connecting' with a locked composer, because the
 * `task_complete` releasing it sat undrained in the owner's queue while the
 * visible Studio mirror applied its own copy. Prompts typed into that tab were
 * then refused as "still connecting" and silently discarded.
 *
 * ── What this pins ──────────────────────────────────────────────────────────
 * With frames never delivered, the queue still drains on the timer fallback.
 * These tests fail against the bare-rAF scheduler: `flush` is never called.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createFlushScheduler, FLUSH_FALLBACK_MS, type SchedulerHost,
} from '../engine-event-flush-scheduler'

vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(),
}))

/**
 * A host whose frames never fire — the hidden-window condition. Timers are
 * captured so the test controls when the fallback runs.
 */
function starvedHost(): SchedulerHost & { runTimers: () => void; pendingTimers: () => number } {
  const timers: Array<{ cb: () => void; ms: number }> = []
  return {
    // Hands back a handle but never invokes the callback: exactly what a
    // non-composited window does.
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: ((cb: () => void, ms: number) => {
      timers.push({ cb, ms })
      return timers.length as unknown as ReturnType<typeof setTimeout>
    }) as SchedulerHost['setTimeout'],
    clearTimeout: ((handle: number) => {
      const idx = (handle as number) - 1
      if (idx >= 0 && idx < timers.length) timers[idx] = { cb: () => {}, ms: 0 }
    }) as unknown as SchedulerHost['clearTimeout'],
    runTimers: () => {
      const pending = timers.splice(0, timers.length)
      for (const t of pending) t.cb()
    },
    pendingTimers: () => timers.length,
  }
}

/** A host where frames fire immediately — the visible-window condition. */
function compositedHost(): SchedulerHost & { clearedTimers: () => number } {
  let cleared = 0
  return {
    requestAnimationFrame: (cb: () => void) => {
      cb()
      return 1
    },
    cancelAnimationFrame: () => {},
    setTimeout: ((cb: () => void) => {
      void cb
      return 7 as unknown as ReturnType<typeof setTimeout>
    }) as SchedulerHost['setTimeout'],
    clearTimeout: (() => {
      cleared += 1
    }) as unknown as SchedulerHost['clearTimeout'],
    clearedTimers: () => cleared,
  }
}

describe('engine event flush scheduler', () => {
  it('drains on the timer when no animation frame is ever delivered', () => {
    const host = starvedHost()
    const flush = vi.fn()
    const scheduler = createFlushScheduler(flush, host)

    scheduler.schedule()
    // The frame never arrives, so nothing has drained yet.
    expect(flush).not.toHaveBeenCalled()

    host.runTimers()
    // This is the assertion the bare-rAF scheduler cannot satisfy.
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('arms the fallback at an interval longer than a frame but well under a second', () => {
    const host = starvedHost()
    const seen: number[] = []
    const spyHost: SchedulerHost = {
      ...host,
      setTimeout: ((cb: () => void, ms: number) => {
        seen.push(ms)
        return host.setTimeout(cb, ms)
      }) as SchedulerHost['setTimeout'],
    }
    createFlushScheduler(vi.fn(), spyHost).schedule()

    expect(seen).toEqual([FLUSH_FALLBACK_MS])
    // Longer than a 60Hz frame so a composited window always wins the race,
    // short enough that a hidden owner is not visibly late.
    expect(FLUSH_FALLBACK_MS).toBeGreaterThan(16)
    expect(FLUSH_FALLBACK_MS).toBeLessThanOrEqual(100)
  })

  it('drains once per schedule when the frame wins, cancelling the timer', () => {
    const host = compositedHost()
    const flush = vi.fn()
    const scheduler = createFlushScheduler(flush, host)

    scheduler.schedule()

    // The frame fired synchronously; the paired timer must not also drain.
    expect(flush).toHaveBeenCalledTimes(1)
    expect(host.clearedTimers()).toBe(1)
  })

  it('coalesces concurrent schedules into a single drain', () => {
    const host = starvedHost()
    const flush = vi.fn()
    const scheduler = createFlushScheduler(flush, host)

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()
    // Three enqueues, one armed drain — the coalescing the queue depends on.
    expect(host.pendingTimers()).toBe(1)

    host.runTimers()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('cancel prevents a pending drain from firing', () => {
    const host = starvedHost()
    const flush = vi.fn()
    const scheduler = createFlushScheduler(flush, host)

    scheduler.schedule()
    scheduler.cancel()
    host.runTimers()

    expect(flush).not.toHaveBeenCalled()
  })
})
