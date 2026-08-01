// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeAll } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

const rWarn = vi.fn()
vi.mock('../../rendererLogger', () => ({
  rWarn: (...args: unknown[]) => rWarn(...args),
}))

import { TimelineMinimap } from './TimelineMinimap'
import type { TimelineMinimapItem } from './TimelineMinimap.logic'

// Controllable IntersectionObserver stub (jsdom has none). Tests drive
// visibility transitions by invoking the captured callback.
type IoCallback = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void
const ioInstances: Array<{ callback: IoCallback; observed: Element[] }> = []

beforeAll(() => {
  // jsdom lacks matchMedia, ResizeObserver, and IntersectionObserver.
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: fine)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    private entry: { callback: IoCallback; observed: Element[] }
    constructor(callback: IoCallback) {
      this.entry = { callback, observed: [] }
      ioInstances.push(this.entry)
    }
    observe(el: Element) { this.entry.observed.push(el) }
    unobserve(el: Element) {
      this.entry.observed = this.entry.observed.filter((o) => o !== el)
    }
    disconnect() { this.entry.observed = [] }
  }
  // The in-view effect defers anchor observation by one frame; run it
  // synchronously so observers are wired inside act().
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0 }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = (() => undefined) as typeof window.cancelAnimationFrame
})

const ITEMS: TimelineMinimapItem[] = [
  { id: 'u1', userText: 'first question', assistantText: 'first answer' },
  { id: 'u2', userText: 'second question', assistantText: null },
  { id: 'u3', userText: 'third question', assistantText: 'third answer' },
]

function renderMinimap(items: TimelineMinimapItem[], opts?: { omitAnchorIds?: string[] }) {
  const container = document.createElement('div')
  document.body.appendChild(container)

  // Scroll container with one anchor per item, offsetTop stubbed since jsdom
  // performs no layout.
  const scrollEl = document.createElement('div')
  const offsets: Record<string, number> = { u1: 100, u2: 500, u3: 900 }
  for (const item of items) {
    if (opts?.omitAnchorIds?.includes(item.id)) continue
    const anchor = document.createElement('div')
    anchor.setAttribute('data-message-id', item.id)
    Object.defineProperty(anchor, 'offsetTop', { value: offsets[item.id] ?? 0 })
    scrollEl.appendChild(anchor)
  }
  const scrollTo = vi.fn()
  ;(scrollEl as unknown as { scrollTo: unknown }).scrollTo = scrollTo
  document.body.appendChild(scrollEl)
  const scrollRef = { current: scrollEl }

  const root = createRoot(container)
  act(() => {
    root.render(React.createElement(TimelineMinimap, { items, scrollRef }))
  })

  const button = container.querySelector('button')
  if (button) {
    // jsdom rects are all zeros; give the rail a real geometry so pointer
    // math resolves. Rail top 100, height 500.
    button.getBoundingClientRect = () =>
      ({ top: 100, bottom: 600, left: 0, right: 18, width: 18, height: 500, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect
  }

  return {
    container,
    button,
    scrollTo,
    /** Most recent IntersectionObserver wired by the component. */
    io: () => ioInstances[ioInstances.length - 1],
    unmount() {
      act(() => { root.unmount() })
      document.body.removeChild(container)
      document.body.removeChild(scrollEl)
    },
  }
}

function mouseEvent(type: string, clientY: number) {
  return new MouseEvent(type, { bubbles: true, clientY })
}

describe('TimelineMinimap', () => {
  it('reserves the gutter with zero items but renders no interactive rail', () => {
    const { container, unmount } = renderMinimap([])
    expect(container.querySelector('[data-testid="timeline-minimap"]')).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelectorAll('[data-minimap-strip]').length).toBe(0)
    unmount()
  })

  it('renders a persistent rail with a single item', () => {
    const { container, unmount } = renderMinimap(ITEMS.slice(0, 1))
    expect(container.querySelector('[data-testid="timeline-minimap"]')).not.toBeNull()
    expect(container.querySelector('button')).not.toBeNull()
    expect(container.querySelectorAll('[data-minimap-strip]').length).toBe(1)
    unmount()
  })

  it('renders one tick per item', () => {
    const { container, unmount } = renderMinimap(ITEMS)
    expect(container.querySelectorAll('[data-minimap-strip]').length).toBe(3)
    unmount()
  })

  it('logs a warning and does not scroll when the jump anchor is missing', () => {
    rWarn.mockClear()
    const { button, scrollTo, unmount } = renderMinimap(ITEMS, { omitAnchorIds: ['u2'] })
    // Pointer at rail middle resolves u2, whose anchor is absent.
    act(() => { button!.dispatchEvent(mouseEvent('click', 350)) })
    expect(scrollTo).not.toHaveBeenCalled()
    expect(rWarn).toHaveBeenCalledTimes(1)
    expect(rWarn).toHaveBeenCalledWith(
      'conversation',
      'minimap jump anchor missing',
      { message_id: 'u2' },
    )
    unmount()
  })

  it('off-screen ticks stay visible and dimmed — never hidden', () => {
    const { container, unmount } = renderMinimap(ITEMS)
    // No IntersectionObserver callback has fired: every tick is out of view.
    // All must still render with a background color and a dimmed (but
    // non-zero) opacity. This is the regression guard for the imperative
    // style reset that turned off-screen ticks transparent.
    const strips = Array.from(
      container.querySelectorAll<HTMLSpanElement>('[data-minimap-strip]'),
    )
    expect(strips.length).toBe(3)
    for (const strip of strips) {
      expect(strip.dataset.inView).toBe('false')
      expect(strip.style.backgroundColor).not.toBe('')
      const opacity = Number(strip.style.opacity)
      expect(opacity).toBeGreaterThan(0)
      expect(opacity).toBeLessThan(1)
    }
    unmount()
  })

  it('IntersectionObserver transitions drive the in-view tick highlight', () => {
    const { container, io, unmount } = renderMinimap(ITEMS)
    const observer = io()
    // The component observed each chapter anchor.
    expect(observer.observed.length).toBe(3)

    const anchorOf = (id: string) =>
      observer.observed.find((el) => (el as HTMLElement).dataset.messageId === id)!

    // u2 scrolls into view.
    act(() => {
      observer.callback([{ target: anchorOf('u2'), isIntersecting: true }])
    })
    const stripStates = () =>
      Array.from(container.querySelectorAll<HTMLSpanElement>('[data-minimap-strip]')).map(
        (s) => s.dataset.inView,
      )
    expect(stripStates()).toEqual(['false', 'true', 'false'])

    // u2 leaves, u3 enters.
    act(() => {
      observer.callback([
        { target: anchorOf('u2'), isIntersecting: false },
        { target: anchorOf('u3'), isIntersecting: true },
      ])
    })
    expect(stripStates()).toEqual(['false', 'false', 'true'])
    unmount()
  })

  it('click resolves the item under the pointer and scrolls to its anchor', () => {
    const { button, scrollTo, unmount } = renderMinimap(ITEMS)
    // Pointer at rail middle (clientY 350 on a 100..600 rail) → index 1 → u2.
    act(() => { button!.dispatchEvent(mouseEvent('click', 350)) })
    expect(scrollTo).toHaveBeenCalledWith({ top: 500 - 24, behavior: 'smooth' })
    unmount()
  })

  it('keyboard: focus activates first item, ArrowDown moves, Enter jumps', () => {
    const { container, button, scrollTo, unmount } = renderMinimap(ITEMS)
    act(() => { button!.dispatchEvent(new FocusEvent('focus', { bubbles: false })) })
    // React attaches focus handlers via focusin delegation in some versions;
    // fall back to calling focus() which fires the synthetic event.
    if (!container.querySelector('[data-minimap-preview]')) {
      act(() => { button!.focus() })
    }
    expect(container.querySelector('[data-minimap-preview]')?.textContent).toContain('first question')

    act(() => {
      button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(container.querySelector('[data-minimap-preview]')?.textContent).toContain('second question')

    act(() => {
      button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(scrollTo).toHaveBeenCalledWith({ top: 500 - 24, behavior: 'smooth' })

    act(() => { button!.dispatchEvent(new FocusEvent('blur', { bubbles: false })) })
    if (container.querySelector('[data-minimap-preview]')) {
      act(() => { button!.blur() })
    }
    expect(container.querySelector('[data-minimap-preview]')).toBeNull()
    unmount()
  })

  it('Home and End jump to the first and last item', () => {
    const { container, button, unmount } = renderMinimap(ITEMS)
    act(() => { button!.focus() })
    act(() => {
      button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(container.querySelector('[data-minimap-preview]')?.textContent).toContain('third question')
    act(() => {
      button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(container.querySelector('[data-minimap-preview]')?.textContent).toContain('first question')
    unmount()
  })

  it('tooltip shows user and assistant text on hover; hidden when idle', () => {
    const { container, button, unmount } = renderMinimap(ITEMS)
    expect(container.querySelector('[data-minimap-preview]')).toBeNull()

    // Hover the top of the rail → index 0.
    act(() => { button!.dispatchEvent(mouseEvent('mousemove', 100)) })
    const preview = container.querySelector('[data-minimap-preview]')
    expect(preview?.textContent).toContain('first question')
    expect(preview?.textContent).toContain('first answer')

    // React derives onMouseLeave from mouseout + relatedTarget outside.
    act(() => {
      button!.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      )
    })
    expect(container.querySelector('[data-minimap-preview]')).toBeNull()
    unmount()
  })

  it('omits the assistant preview when the item has none', () => {
    const { container, button, unmount } = renderMinimap(ITEMS)
    act(() => { button!.dispatchEvent(mouseEvent('mousemove', 350)) })
    const preview = container.querySelector('[data-minimap-preview]')
    expect(preview?.textContent).toContain('second question')
    expect(preview?.textContent).not.toContain('answer')
    unmount()
  })

  it('events inside the preview do not retarget or jump', () => {
    const { container, button, scrollTo, unmount } = renderMinimap(ITEMS)
    act(() => { button!.dispatchEvent(mouseEvent('mousemove', 100)) })
    const preview = container.querySelector('[data-minimap-preview]')!

    // Click inside the preview must not scroll.
    act(() => { preview.dispatchEvent(mouseEvent('click', 400)) })
    expect(scrollTo).not.toHaveBeenCalled()

    // Mousemove inside the preview must not retarget the active item.
    act(() => { preview.dispatchEvent(mouseEvent('mousemove', 590)) })
    expect(container.querySelector('[data-minimap-preview]')?.textContent).toContain('first question')
    unmount()
  })
})
