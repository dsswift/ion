// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Chart-jump convergence.
 *
 * THE BUG THIS EXISTS FOR: `scrollToIndex` computes its target from row
 * ESTIMATES. In a transcript of long tool output and 380px chart cards the
 * estimates are far too low — one measured jump grew the list's total size
 * from 38,024px to 65,919px *during the jump itself*. The offset the call
 * aimed at no longer pointed at the target row once measurement finished, so
 * the viewport landed thousands of pixels away and the click appeared to do
 * nothing at all.
 *
 * Tuning the estimates cannot fix it: the error depends on whatever content
 * sits above the target, so it is unbounded. The jump must RE-TARGET as the
 * list settles.
 *
 * These tests drive the same convergence loop the transcript uses, against a
 * virtualizer stub whose measured offset moves for the first few frames —
 * exactly what real first-time measurement does.
 */

/** Runs queued rAF callbacks so a test can advance frame by frame. */
function installFrameQueue(): { flush: (frames: number) => void } {
  let queue: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push(cb)
    return queue.length
  })
  return {
    flush(frames: number) {
      for (let i = 0; i < frames; i += 1) {
        const pending = queue
        queue = []
        for (const cb of pending) cb(0)
      }
    },
  }
}

/**
 * The convergence loop, extracted verbatim in shape from TranscriptRows so the
 * test exercises the real algorithm rather than a paraphrase of it.
 */
function jumpToIndex(opts: {
  el: { scrollTop: number }
  offsetForIndex: () => number | undefined
  maxFrames: number
  onSettled?: (attempts: number) => void
  onGaveUp?: (attempts: number) => void
}): void {
  let attempts = 0
  let lastTarget = -1
  const settle = (): void => {
    attempts += 1
    const target = opts.offsetForIndex()
    if (target == null) return
    const drift = Math.abs(opts.el.scrollTop - target)
    const targetMoved = target !== lastTarget
    lastTarget = target
    if (!targetMoved && drift <= 2) {
      opts.onSettled?.(attempts)
      return
    }
    opts.el.scrollTop = target
    if (attempts >= opts.maxFrames) {
      opts.onGaveUp?.(attempts)
      return
    }
    requestAnimationFrame(settle)
  }
  requestAnimationFrame(settle)
}

describe('chart jump convergence', () => {
  let frames: ReturnType<typeof installFrameQueue>

  beforeEach(() => { frames = installFrameQueue() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('lands on the final offset when the list grows during the jump', () => {
    // The measured case: the target's offset moves for three frames as rows
    // above it measure, then stabilises. A single scroll would strand the
    // viewport at the first value.
    const targets = [6192, 12800, 19430, 19430, 19430]
    let call = 0
    const el = { scrollTop: 37108 }
    let settledAt = -1

    jumpToIndex({
      el,
      offsetForIndex: () => targets[Math.min(call++, targets.length - 1)],
      maxFrames: 30,
      onSettled: (n) => { settledAt = n },
    })
    frames.flush(10)

    expect(el.scrollTop).toBe(19430)
    expect(settledAt).toBeGreaterThan(1)
  })

  it('does not stop at the first offset the virtualizer reports', () => {
    // This is precisely what the old single-call behavior did.
    const targets = [6192, 19430, 19430]
    let call = 0
    const el = { scrollTop: 37108 }

    jumpToIndex({
      el,
      offsetForIndex: () => targets[Math.min(call++, targets.length - 1)],
      maxFrames: 30,
    })
    frames.flush(10)

    expect(el.scrollTop).not.toBe(6192)
  })

  it('settles immediately when the row is already in position', () => {
    // A jump to a chart the operator already scrolled to must not thrash.
    const el = { scrollTop: 5000 }
    let settledAt = -1
    jumpToIndex({
      el,
      offsetForIndex: () => 5000,
      maxFrames: 30,
      onSettled: (n) => { settledAt = n },
    })
    frames.flush(5)

    expect(el.scrollTop).toBe(5000)
    expect(settledAt).toBe(2)
  })

  it('gives up at the frame cap rather than spinning forever', () => {
    // A transcript whose height never stabilises must not loop indefinitely.
    let moving = 0
    const el = { scrollTop: 0 }
    let gaveUpAt = -1

    jumpToIndex({
      el,
      offsetForIndex: () => (moving += 100),
      maxFrames: 30,
      onGaveUp: (n) => { gaveUpAt = n },
    })
    frames.flush(50)

    expect(gaveUpAt).toBe(30)
  })

  it('stops when the row disappears mid-jump', () => {
    // A rewind can remove the target while the loop is converging.
    const el = { scrollTop: 100 }
    let settledAt = -1
    let gaveUpAt = -1
    jumpToIndex({
      el,
      offsetForIndex: () => undefined,
      maxFrames: 30,
      onSettled: (n) => { settledAt = n },
      onGaveUp: (n) => { gaveUpAt = n },
    })
    frames.flush(5)

    expect(settledAt).toBe(-1)
    expect(gaveUpAt).toBe(-1)
    expect(el.scrollTop).toBe(100)
  })
})

/**
 * Anchoring on the chart card rather than the turn.
 *
 * A grouped row is a whole TURN — assistant text, then tool rows, then the
 * chart card at the very end. Landing on the row's start parked the operator
 * at the top of a turn that can be several screens tall, with the chart they
 * clicked still below the fold. Once the row is mounted the card's position is
 * measurable, so the loop converges on the CARD.
 */
describe('chart jump anchoring', () => {
  let frames: ReturnType<typeof installFrameQueue>

  beforeEach(() => { frames = installFrameQueue() })
  afterEach(() => { vi.unstubAllGlobals() })

  /** Convergence loop with the chart-element refinement, as shipped. */
  function jumpAnchored(opts: {
    el: { scrollTop: number; clientHeight: number }
    rowOffset: () => number
    /** Distance from viewport top to the card, or null while unmounted. */
    chartDelta: () => number | null
    totalSize: number
    topMargin: number
    maxFrames: number
    onSettled?: (target: number) => void
  }): void {
    let attempts = 0
    let lastTarget = -1
    const settle = (): void => {
      attempts += 1
      const rowTarget = opts.rowOffset()
      const delta = opts.chartDelta()
      const target = delta == null
        ? rowTarget
        : Math.max(0, Math.min(
          opts.el.scrollTop + delta - opts.topMargin,
          opts.totalSize - opts.el.clientHeight,
        ))
      const drift = Math.abs(opts.el.scrollTop - target)
      const moved = target !== lastTarget
      lastTarget = target
      if (!moved && drift <= 2) { opts.onSettled?.(target); return }
      opts.el.scrollTop = target
      if (attempts >= opts.maxFrames) return
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }

  it('lands on the chart card, not the top of its turn', () => {
    // The turn starts at 10,000; the card sits 4,000px further down.
    const el = { scrollTop: 0, clientHeight: 800 }
    let settled = -1
    jumpAnchored({
      el,
      rowOffset: () => 10000,
      // Once scrolled to the row start, the card is 4000px below the viewport
      // top; after the correcting scroll it sits at the margin.
      chartDelta: () => (el.scrollTop === 0 ? 14000 : 16),
      totalSize: 60000,
      topMargin: 16,
      maxFrames: 30,
      onSettled: (t) => { settled = t },
    })
    frames.flush(10)

    // 14000 - 16 margin => the CARD is in view, far below the turn's start.
    expect(el.scrollTop).toBe(13984)
    expect(settled).toBe(13984)
    expect(el.scrollTop).toBeGreaterThan(10000)
  })

  it('falls back to the row while the card is not yet mounted', () => {
    // The first frames of a jump into unmounted territory have no element to
    // measure; the row offset still gets the viewport into the neighbourhood.
    const el = { scrollTop: 0, clientHeight: 800 }
    jumpAnchored({
      el,
      rowOffset: () => 10000,
      chartDelta: () => null,
      totalSize: 60000,
      topMargin: 16,
      maxFrames: 30,
    })
    frames.flush(5)

    expect(el.scrollTop).toBe(10000)
  })

  it('never scrolls past the end of the list', () => {
    // A chart in the final turn must not compute an offset beyond the
    // scrollable range, which would leave the viewport clamped somewhere the
    // convergence loop never agrees with.
    const el = { scrollTop: 50000, clientHeight: 800 }
    jumpAnchored({
      el,
      rowOffset: () => 59000,
      chartDelta: () => 9000,
      totalSize: 60000,
      topMargin: 16,
      maxFrames: 30,
    })
    frames.flush(10)

    expect(el.scrollTop).toBeLessThanOrEqual(60000 - 800)
  })

  it('never scrolls above the top of the list', () => {
    const el = { scrollTop: 100, clientHeight: 800 }
    jumpAnchored({
      el,
      rowOffset: () => 0,
      chartDelta: () => -500,
      totalSize: 60000,
      topMargin: 16,
      maxFrames: 30,
    })
    frames.flush(10)

    expect(el.scrollTop).toBe(0)
  })
})

/**
 * Wiring.
 *
 * The tests above replicate the convergence algorithm, so they stay green even
 * if the transcript stops using it — reverting the chart-element lookup left
 * all nine passing while restoring the original defect. These read the real
 * source, which is the only thing that answers "is it actually wired".
 */
describe('chart jump wiring', () => {
  const source = readFileSync(join(__dirname, 'TranscriptRows.tsx'), 'utf8')

  it('requires several consecutive quiet frames before settling', () => {
    // The tests above replicate the loop, so they stay green if the real
    // constant changes. This reads the source, which is what actually ships.
    const match = /JUMP_SETTLE_QUIET_FRAMES = (\d+)/.exec(source)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(3)
  })

  it('targets the chart CARD, not the moved marker', () => {
    // A revised chart renders a ChartMovedMarker at every superseded
    // revision, pointing forward to the current one. The marker carries the
    // chart's id too, and it sits EARLIER in the document than the card, so a
    // querySelector on the id alone matched the marker and scrolled there —
    // above the user message that opens the chart's own turn.
    //
    // Single-revision charts have no marker, which is why only revised charts
    // missed, and why the miss looked random until the marker was noticed.
    expect(source).toContain('data-chart-card=')
    expect(source).not.toMatch(/querySelector\(`\[data-chart-id=/)
  })

  it('requires the list total size to be still, not just the target', () => {
    // The replicated loops above stay green if the real loop stops checking
    // total size; this reads the source that actually ships.
    expect(source).toContain('const sizeMoved = totalSize !== lastTotalSize')
    expect(source).toContain('!targetMoved && !sizeMoved && drift <= 2')
  })

  it('resets the quiet counter when the target moves again', () => {
    // Without the reset, six non-consecutive quiet frames would settle a
    // target that is still moving.
    expect(source).toContain('quietFrames = 0')
  })

  it('resolves the chart element to refine the target', () => {
    expect(source).toContain('data-chart-id')
    expect(source).toMatch(/getBoundingClientRect\(\)\.top/)
  })

  it('accepts a chart id alongside the row id', () => {
    // Without the second argument the jump can only anchor on the turn.
    expect(source).toMatch(/virtualMessageJumpRef\.current = \(messageId, chartId\)/)
  })

  it('clamps the computed target into the scrollable range', () => {
    expect(source).toMatch(/Math\.max\(0, Math\.min\(/)
    expect(source).toContain('virtualizer.getTotalSize() - el.clientHeight')
  })

  it('reports which anchor it settled on', () => {
    // Distinguishes "landed on the card" from "fell back to the turn" without
    // another rebuild cycle.
    expect(source).toContain('anchored_on')
  })
})

/**
 * Settling requires SEVERAL quiet frames, not one.
 *
 * THE BUG THIS EXISTS FOR: the loop exited the first time the target held and
 * the viewport was on it. A virtualized list measures in bursts, so one quiet
 * frame proves nothing — the next batch of rows above the target resolves and
 * moves it again. Real jumps settled after 5-7 attempts with
 * `anchored_on: chart_element`, meaning the anchor was correct and the loop
 * simply stopped too early, leaving the viewport at the top of the turn.
 */
describe('settle requires sustained quiet', () => {
  let frames: ReturnType<typeof installFrameQueue>

  beforeEach(() => { frames = installFrameQueue() })
  afterEach(() => { vi.unstubAllGlobals() })

  /** The convergence loop with the consecutive-quiet-frame requirement. */
  function jumpWithQuietRequirement(opts: {
    el: { scrollTop: number }
    offsetForIndex: () => number | undefined
    quietRequired: number
    maxFrames: number
    onSettled?: (attempts: number) => void
  }): void {
    let attempts = 0
    let lastTarget = -1
    let quiet = 0
    const settle = (): void => {
      attempts += 1
      const target = opts.offsetForIndex()
      if (target == null) return
      const drift = Math.abs(opts.el.scrollTop - target)
      const targetMoved = target !== lastTarget
      lastTarget = target
      if (!targetMoved && drift <= 2) {
        quiet += 1
        if (quiet >= opts.quietRequired) { opts.onSettled?.(attempts); return }
        requestAnimationFrame(settle)
        return
      }
      quiet = 0
      opts.el.scrollTop = target
      if (attempts >= opts.maxFrames) return
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }

  it('does not settle on a single quiet frame that is followed by movement', () => {
    // The measured shape: the target holds briefly, then a later measurement
    // burst moves it. Exiting on that first hold is what stranded the view.
    const targets = [5000, 5000, 8000, 8000, 8000, 8000, 8000, 8000, 8000]
    let call = 0
    const el = { scrollTop: 5000 }
    let settledAt = -1

    jumpWithQuietRequirement({
      el,
      offsetForIndex: () => targets[Math.min(call++, targets.length - 1)],
      quietRequired: 6,
      maxFrames: 30,
      onSettled: (n) => { settledAt = n },
    })
    frames.flush(20)

    expect(el.scrollTop).toBe(8000)
    expect(settledAt).toBeGreaterThan(2)
  })

  it('a one-frame requirement stops early on the same input', () => {
    // Direct contrast: this is the previous behavior, and it lands wrong.
    const targets = [5000, 5000, 8000, 8000, 8000]
    let call = 0
    const el = { scrollTop: 5000 }

    jumpWithQuietRequirement({
      el,
      offsetForIndex: () => targets[Math.min(call++, targets.length - 1)],
      quietRequired: 1,
      maxFrames: 30,
    })
    frames.flush(20)

    expect(el.scrollTop).toBe(5000)
  })

  it('still settles promptly when the target never moves', () => {
    const el = { scrollTop: 4000 }
    let settledAt = -1
    jumpWithQuietRequirement({
      el,
      offsetForIndex: () => 4000,
      quietRequired: 6,
      maxFrames: 30,
      onSettled: (n) => { settledAt = n },
    })
    frames.flush(20)

    // Frame 1 establishes lastTarget (targetMoved is true against the -1
    // sentinel), so six QUIET frames follow it.
    expect(settledAt).toBe(7)
    expect(el.scrollTop).toBe(4000)
  })
})

/**
 * A still TARGET is not a still LIST.
 *
 * THE BUG THIS EXISTS FOR: a long jump crosses many never-rendered virtual
 * rows. As each one measures, the list grows beneath the target — but the
 * target itself can hold steady for six frames while that is still happening,
 * so the loop declared convergence mid-measurement.
 *
 * The evidence was the landing spread. The same long jump settled 22,744px
 * from its start on one attempt and 28,712px on the next, while a short jump
 * in the same conversation landed within 764px every single time. Short jumps
 * looked perfect because they cross almost nothing.
 *
 * Settling therefore requires the virtualizer's total size to be still too.
 */
describe('settle requires a still list, not just a still target', () => {
  let frames: ReturnType<typeof installFrameQueue>

  beforeEach(() => { frames = installFrameQueue() })
  afterEach(() => { vi.unstubAllGlobals() })

  /** The convergence loop as shipped: target AND total size must hold. */
  function jump(opts: {
    el: { scrollTop: number }
    target: () => number
    totalSize: () => number
    requireSizeStable: boolean
    quietRequired: number
    maxFrames: number
    onSettled?: (attempts: number) => void
  }): void {
    let attempts = 0
    let lastTarget = -1
    let lastSize = -1
    let quiet = 0
    const settle = (): void => {
      attempts += 1
      const target = opts.target()
      const size = opts.totalSize()
      const drift = Math.abs(opts.el.scrollTop - target)
      const targetMoved = target !== lastTarget
      const sizeMoved = size !== lastSize
      lastTarget = target
      lastSize = size
      const still = opts.requireSizeStable ? !targetMoved && !sizeMoved : !targetMoved
      if (still && drift <= 2) {
        quiet += 1
        if (quiet >= opts.quietRequired) { opts.onSettled?.(attempts); return }
        requestAnimationFrame(settle)
        return
      }
      quiet = 0
      opts.el.scrollTop = target
      if (attempts >= opts.maxFrames) return
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }

  /**
   * The measured shape of a long jump: the target holds while the list is
   * still growing, then a late measurement burst moves it.
   */
  const longJump = () => {
    let frame = 0
    return {
      target: () => { frame += 1; return frame <= 8 ? 50000 : 54148 },
      // Total size keeps climbing through the window where the target holds.
      totalSize: () => 60000 + Math.min(frame, 12) * 500,
    }
  }

  it('does not settle while the list is still growing', () => {
    const seq = longJump()
    const el = { scrollTop: 25436 }
    let settledAt = -1

    jump({
      el,
      target: seq.target,
      totalSize: seq.totalSize,
      requireSizeStable: true,
      quietRequired: 6,
      maxFrames: 90,
      onSettled: (n) => { settledAt = n },
    })
    frames.flush(60)

    expect(el.scrollTop).toBe(54148)
    expect(settledAt).toBeGreaterThan(12)
  })

  it('settles early on the same input when only the target is watched', () => {
    // Direct contrast: this is the previous behavior, and it lands short.
    const seq = longJump()
    const el = { scrollTop: 25436 }

    jump({
      el,
      target: seq.target,
      totalSize: seq.totalSize,
      requireSizeStable: false,
      quietRequired: 6,
      maxFrames: 90,
    })
    frames.flush(60)

    expect(el.scrollTop).toBe(50000)
  })

  it('a short jump still settles promptly', () => {
    // Short jumps cross almost nothing, so requiring size-stability must not
    // make the common case slower.
    const el = { scrollTop: 20804 }
    let settledAt = -1

    jump({
      el,
      target: () => 21568,
      totalSize: () => 60000,
      requireSizeStable: true,
      quietRequired: 6,
      maxFrames: 90,
      onSettled: (n) => { settledAt = n },
    })
    frames.flush(30)

    expect(el.scrollTop).toBe(21568)
    expect(settledAt).toBeLessThanOrEqual(8)
  })
})
