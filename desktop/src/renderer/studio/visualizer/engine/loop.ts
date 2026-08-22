/**
 * Fixed-timestep game loop over requestAnimationFrame. Simulation ticks at a
 * constant rate (accumulator pattern) so behavior is frame-rate independent;
 * rendering happens once per animation frame. Pauses when the document is
 * hidden — a hidden visualizer burns zero CPU.
 */

export interface GameLoop {
  start(): void
  stop(): void
}

/** Simulation ticks per second. */
export const TICK_RATE = 30
const MAX_CATCHUP_SECONDS = 0.5

export function createGameLoop(tick: (dt: number) => void, render: (animClock: number) => void): GameLoop {
  let rafId: number | null = null
  let last = 0
  let accumulator = 0
  let animClock = 0
  const step = 1 / TICK_RATE

  function frame(now: number): void {
    rafId = requestAnimationFrame(frame)
    if (last === 0) {
      last = now
      return
    }
    // Clamp catch-up after tab-hidden gaps so we never spiral.
    accumulator += Math.min((now - last) / 1000, MAX_CATCHUP_SECONDS)
    last = now
    while (accumulator >= step) {
      tick(step)
      animClock += step
      accumulator -= step
    }
    render(animClock)
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      if (rafId != null) cancelAnimationFrame(rafId)
      rafId = null
      last = 0
    } else if (rafId == null) {
      rafId = requestAnimationFrame(frame)
    }
  }

  return {
    start() {
      if (rafId != null) return
      document.addEventListener('visibilitychange', onVisibility)
      rafId = requestAnimationFrame(frame)
    },
    stop() {
      document.removeEventListener('visibilitychange', onVisibility)
      if (rafId != null) cancelAnimationFrame(rafId)
      rafId = null
      last = 0
    },
  }
}
