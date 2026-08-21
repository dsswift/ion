// @vitest-environment jsdom
/**
 * useResizablePane — one-axis, one-edge Studio seam resize primitive.
 *
 * Behavior pinned:
 *   - clamps to [min, max] on both live resize and commit
 *   - 'end' edge grows with the pointer, 'start' edge grows against it
 *   - onResize is rAF-coalesced (many moves in one frame → one call)
 *   - onCommit fires exactly once, on pointerup, with the final size
 *   - pointercancel commits too (last-seen geometry is truth, no snap-back)
 *   - disabled handle starts no gesture
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useResizablePane, type ResizablePaneOptions, type ResizablePaneResult } from '../useResizablePane'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no rAF; make it synchronous-on-flush so coalescing is testable.
let rafQueue: FrameRequestCallback[] = []
beforeEach(() => {
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    rafQueue[id - 1] = () => undefined
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function flushRaf(): void {
  const q = rafQueue
  rafQueue = []
  for (const cb of q) cb(performance.now())
}

/** Minimal renderHook (repo convention — see useEdgeResize.test.ts). */
function renderHook(opts: ResizablePaneOptions): {
  result: () => ResizablePaneResult
  rerender: (next: ResizablePaneOptions) => void
  unmount: () => void
} {
  let current: ResizablePaneResult | null = null
  function Host(props: { o: ResizablePaneOptions }): null {
    current = useResizablePane(props.o)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Host o={opts} />)
  })
  return {
    result: () => {
      if (!current) throw new Error('hook not rendered')
      return current
    },
    rerender: (next) => {
      act(() => {
        root.render(<Host o={next} />)
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** A handle element with pointer-capture stubs (jsdom lacks them). */
function makeHandle(): HTMLElement {
  const el = document.createElement('div')
  el.setPointerCapture = vi.fn()
  el.releasePointerCapture = vi.fn()
  document.body.appendChild(el)
  return el
}

function pointerDown(hook: ResizablePaneResult, el: HTMLElement, coord: { x?: number; y?: number } = {}): void {
  act(() => {
    hook.handleProps.onPointerDown({
      button: 0,
      pointerId: 1,
      clientX: coord.x ?? 0,
      clientY: coord.y ?? 0,
      currentTarget: el,
    } as unknown as React.PointerEvent<HTMLElement>)
  })
}

function fire(el: HTMLElement, type: string, coord: { x?: number; y?: number }): void {
  const ev = new Event(type, { bubbles: false }) as PointerEvent
  Object.assign(ev, { pointerId: 1, clientX: coord.x ?? 0, clientY: coord.y ?? 0 })
  act(() => {
    el.dispatchEvent(ev)
  })
}

function baseOpts(over: Partial<ResizablePaneOptions> = {}): ResizablePaneOptions {
  return {
    axis: 'x',
    edge: 'end',
    min: 100,
    max: 800,
    size: 400,
    onResize: vi.fn(),
    onCommit: vi.fn(),
    ...over,
  }
}

describe('useResizablePane', () => {
  it("'end' edge: pane grows with the pointer; commit once with final size", () => {
    const opts = baseOpts()
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { x: 500 })
    expect(h.result().dragging).toBe(true)

    fire(el, 'pointermove', { x: 550 }) // +50
    flushRaf()
    expect(opts.onResize).toHaveBeenLastCalledWith(450)

    fire(el, 'pointerup', { x: 550 })
    expect(opts.onCommit).toHaveBeenCalledTimes(1)
    expect(opts.onCommit).toHaveBeenCalledWith(450)
    expect(h.result().dragging).toBe(false)
    h.unmount()
  })

  it("'start' edge: pane grows against the pointer (right panel dragged left)", () => {
    const opts = baseOpts({ edge: 'start' })
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { x: 500 })
    fire(el, 'pointermove', { x: 440 }) // pointer left 60 → grow 60
    flushRaf()
    expect(opts.onResize).toHaveBeenLastCalledWith(460)
    fire(el, 'pointerup', { x: 440 })
    expect(opts.onCommit).toHaveBeenCalledWith(460)
    h.unmount()
  })

  it('y axis uses clientY', () => {
    const opts = baseOpts({ axis: 'y', edge: 'start', size: 240, min: 120, max: 800 })
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { y: 600 })
    fire(el, 'pointermove', { y: 520 }) // up 80 → bottom panel grows 80
    flushRaf()
    expect(opts.onResize).toHaveBeenLastCalledWith(320)
    fire(el, 'pointerup', { y: 520 })
    expect(opts.onCommit).toHaveBeenCalledWith(320)
    h.unmount()
  })

  it('clamps to [min, max] live and on commit', () => {
    const opts = baseOpts({ min: 200, max: 500 })
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { x: 0 })
    fire(el, 'pointermove', { x: 900 }) // way past max
    flushRaf()
    expect(opts.onResize).toHaveBeenLastCalledWith(500)
    fire(el, 'pointermove', { x: -900 }) // way past min
    flushRaf()
    expect(opts.onResize).toHaveBeenLastCalledWith(200)
    fire(el, 'pointerup', { x: -900 })
    expect(opts.onCommit).toHaveBeenCalledWith(200)
    h.unmount()
  })

  it('rAF coalescing: many moves in one frame → one onResize with the last value', () => {
    const opts = baseOpts()
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { x: 500 })
    fire(el, 'pointermove', { x: 510 })
    fire(el, 'pointermove', { x: 520 })
    fire(el, 'pointermove', { x: 530 })
    expect(opts.onResize).not.toHaveBeenCalled() // nothing until the frame
    flushRaf()
    expect(opts.onResize).toHaveBeenCalledTimes(1)
    expect(opts.onResize).toHaveBeenCalledWith(430)
    fire(el, 'pointerup', { x: 530 })
    expect(opts.onCommit).toHaveBeenCalledWith(430)
    h.unmount()
  })

  it('commit uses the final position even when the last frame never painted', () => {
    const opts = baseOpts()
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { x: 500 })
    fire(el, 'pointermove', { x: 560 })
    // No flushRaf: release before the frame fires.
    fire(el, 'pointerup', { x: 560 })
    expect(opts.onCommit).toHaveBeenCalledWith(460)
    h.unmount()
  })

  it('pointercancel commits the last-seen size (no snap-back)', () => {
    const opts = baseOpts()
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { x: 500 })
    fire(el, 'pointermove', { x: 460 })
    flushRaf()
    fire(el, 'pointercancel', { x: 460 })
    expect(opts.onCommit).toHaveBeenCalledTimes(1)
    expect(opts.onCommit).toHaveBeenCalledWith(360)
    expect(h.result().dragging).toBe(false)
    h.unmount()
  })

  it('disabled: no gesture starts, no callbacks fire', () => {
    const opts = baseOpts({ disabled: true })
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { x: 500 })
    expect(h.result().dragging).toBe(false)
    fire(el, 'pointermove', { x: 600 })
    flushRaf()
    expect(opts.onResize).not.toHaveBeenCalled()
    fire(el, 'pointerup', { x: 600 })
    expect(opts.onCommit).not.toHaveBeenCalled()
    h.unmount()
  })

  it('non-primary button is ignored', () => {
    const opts = baseOpts()
    const h = renderHook(opts)
    const el = makeHandle()
    act(() => {
      h.result().handleProps.onPointerDown({
        button: 2,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        currentTarget: el,
      } as unknown as React.PointerEvent<HTMLElement>)
    })
    expect(h.result().dragging).toBe(false)
    h.unmount()
  })

  it('unmount mid-drag: no commit, no crash', () => {
    const opts = baseOpts()
    const h = renderHook(opts)
    const el = makeHandle()
    pointerDown(h.result(), el, { x: 500 })
    fire(el, 'pointermove', { x: 560 })
    h.unmount()
    expect(opts.onCommit).not.toHaveBeenCalled()
  })
})
