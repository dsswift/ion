// engine-event-flush-scheduler.ts — the wake-up source for the inbound engine
// stream's frame queue.
//
// ── Why this is not a bare requestAnimationFrame ────────────────────────────
//
// The queue in engine-event-frame-queue.ts coalesces one frame's worth of
// inbound work. Draining it from `requestAnimationFrame` alone is correct only
// while the window is being composited.
//
// The Desktop is one client with two presentations (ADR-021). The Overlay
// renderer is the session-store OWNER in BOTH of them: in Studio mode the
// Overlay window is HIDDEN but its renderer keeps running, keeps the engine
// connection, and keeps every conversation (see main/active-ui.ts, which hides
// the glass rather than closing it, precisely so runs are uninterrupted).
//
// Electron stops delivering animation frames to a hidden window. So a hidden
// OWNER kept enqueueing inbound events and scheduling a frame that never
// arrived — starving itself of the ENTIRE event stream: text deltas, tool
// results, permission requests, and run completions alike. Observed live: a
// conversation whose run finished stayed 'connecting' forever with a locked
// composer, because the `task_complete` that would have released it sat in the
// owner's queue while the visible Studio mirror applied its own copy and moved
// on. Every prompt typed into that tab was then refused as "still connecting"
// and silently discarded.
//
// ── The contract ────────────────────────────────────────────────────────────
//
// Coalescing is preserved; only the wake-up source changes. Each schedule arms
// BOTH a frame request and a timer, and whichever fires first drains the queue
// and cancels its twin. A composited window therefore behaves exactly as
// before (the frame always wins the race at 60Hz vs the timer's floor), and a
// hidden window drains on the timer at a bounded interval instead of never.

import { rDebug } from '../rendererLogger'

/**
 * Timer fallback interval. Comfortably longer than a 60Hz frame (~16ms) so a
 * composited window always drains on its frame and the timer is pure backstop,
 * yet short enough that a hidden owner stays responsive to the engine — status
 * transitions and permission requests must not wait on a human-visible delay.
 */
export const FLUSH_FALLBACK_MS = 50

/** Injectable clock/frame surface, so tests can starve either source. */
export interface SchedulerHost {
  requestAnimationFrame: (cb: () => void) => number
  cancelAnimationFrame: (handle: number) => void
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

export interface FlushScheduler {
  /** Arm a drain. Idempotent while one is already pending. */
  schedule: () => void
  /** Cancel any pending drain. Call on unsubscribe. */
  cancel: () => void
}

function defaultHost(): SchedulerHost {
  return {
    requestAnimationFrame: (cb) => requestAnimationFrame(cb),
    cancelAnimationFrame: (h) => cancelAnimationFrame(h),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h),
  }
}

/**
 * Build a scheduler that drains via `flush` on the first of an animation frame
 * or the fallback timer.
 *
 * `flush` is invoked at most once per `schedule()` — the winning source cancels
 * the loser before running, so a visible window never double-drains.
 */
export function createFlushScheduler(
  flush: () => void,
  host: SchedulerHost = defaultHost(),
): FlushScheduler {
  let frameHandle = 0
  let timerHandle: ReturnType<typeof setTimeout> | null = null
  /**
   * True from `schedule()` until the drain runs. The two handles cannot carry
   * this alone: a host whose `requestAnimationFrame` invokes its callback
   * synchronously would drain before either handle is assigned, and the arming
   * code would then leave a stray timer behind to drain a second time. Real
   * browsers never do that, but the scheduler must not depend on it.
   */
  let armed = false

  const clearPending = (): void => {
    if (frameHandle) {
      host.cancelAnimationFrame(frameHandle)
      frameHandle = 0
    }
    if (timerHandle !== null) {
      host.clearTimeout(timerHandle)
      timerHandle = null
    }
    armed = false
  }

  /** Run the drain, attributing which source won so a starved window is visible. */
  const run = (source: 'frame' | 'timer'): void => {
    if (!armed) return
    clearPending()
    // The timer winning means this window is not being composited (hidden
    // owner in Studio mode, or a fully occluded window). That is the exact
    // condition that used to strand the stream, so it is recorded rather than
    // inferred from the absence of frame-flush lines.
    if (source === 'timer') {
      rDebug('event.stream', 'flush via timer fallback', { reason: 'no animation frame delivered' })
    }
    flush()
  }

  return {
    schedule: () => {
      if (armed) return
      armed = true
      // Timer first: if the host's frame callback runs synchronously, `run`
      // clears this handle rather than stranding it.
      timerHandle = host.setTimeout(() => run('timer'), FLUSH_FALLBACK_MS)
      const handle = host.requestAnimationFrame(() => run('frame'))
      // A synchronous frame already drained and cleared; do not re-arm.
      if (armed) frameHandle = handle
      else host.cancelAnimationFrame(handle)
    },
    cancel: clearPending,
  }
}
