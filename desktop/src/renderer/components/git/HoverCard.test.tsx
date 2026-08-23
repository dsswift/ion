// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => document.body,
}))
vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1.5 }) },
}))
vi.mock('../../hooks/useViewportClamp', () => ({
  useViewportClamp: vi.fn(),
}))

import { HoverCard } from './HoverCard'

describe('HoverCard zoom placement', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('converts a hovered viewport rectangle once before fixed placement', () => {
    act(() => {
      root.render(<HoverCard content="Details"><span>Target</span></HoverCard>)
    })
    const trigger = host.querySelector('span') as HTMLSpanElement
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 300, y: 150, top: 150, left: 300, right: 450, bottom: 180, width: 150, height: 30, toJSON: () => ({}),
    } as DOMRect)

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(400)
    })

    const card = document.querySelector('[data-testid="hover-card"]') as HTMLElement
    expect(card.style.bottom).toBe(`${window.innerHeight / 1.5 - 100 + 4}px`)
    expect(card.style.left).toBe('250px')
  })

  it('can clear a containing panel before opening a right-side card', () => {
    const boundary = document.createElement('aside')
    vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 660, bottom: 600, width: 660, height: 600, toJSON: () => ({}),
    } as DOMRect)
    const boundaryRef = { current: boundary }
    act(() => {
      root.render(<HoverCard content="Details" position="right" rightBoundaryRef={boundaryRef} delayMs={0}><span>Target</span></HoverCard>)
    })
    const trigger = host.querySelector('span') as HTMLSpanElement
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 30, y: 60, top: 60, left: 30, right: 90, bottom: 80, width: 60, height: 20, toJSON: () => ({}),
    } as DOMRect)

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(0)
    })

    const card = document.querySelector('[data-testid="hover-card"]') as HTMLElement
    expect(card.style.left).toBe('444px')
    expect(card.style.top).toBe(`${70 / 1.5}px`)
  })

  it('supports immediate right-side cards for dense rows', () => {
    act(() => {
      root.render(<HoverCard content="Details" position="right" delayMs={0}><span>Target</span></HoverCard>)
    })
    const trigger = host.querySelector('span') as HTMLSpanElement
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 30, y: 60, top: 60, left: 30, right: 90, bottom: 80, width: 60, height: 20, toJSON: () => ({}),
    } as DOMRect)

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(0)
    })

    const card = document.querySelector('[data-testid="hover-card"]') as HTMLElement
    expect(card.style.left).toBe('64px')
    expect(card.style.top).toBe(`${70 / 1.5}px`)
    expect(card.style.transform).toBe('translateY(-50%)')
  })
})
