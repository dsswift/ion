// @vitest-environment jsdom
/**
 * Pins the toast auto-dismiss timer behavior, including the hover-pause:
 *
 *  - a toast dismisses itself after AUTO_DISMISS_MS (5s),
 *  - hovering the toast pauses the countdown for as long as the pointer
 *    stays (the timer must NOT fire while hovered, no matter how long),
 *  - leaving resumes the countdown from where it left off (time consumed
 *    before the hover still counts against the window).
 *
 * Renders via react-dom/client createRoot + act (StatusBarEngineState
 * pattern) with vi.useFakeTimers driving both setTimeout and Date.now —
 * the pause bookkeeping subtracts elapsed wall-clock, so faking Date
 * alongside the timers keeps the arithmetic exact.
 */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, onMouseEnter, onMouseLeave, style }: {
      children?: React.ReactNode
      onMouseEnter?: React.MouseEventHandler<HTMLDivElement>
      onMouseLeave?: React.MouseEventHandler<HTMLDivElement>
      style?: React.CSSProperties
    }) => (
      <div data-testid="toast" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={style}>
        {children}
      </div>
    ),
  },
}))

vi.mock('@phosphor-icons/react', () => ({
  X: () => null,
}))

// Sentinel palette — the component only needs token strings.
vi.mock('../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `token-${String(key)}` }),
}))

import { EngineNotificationToasts, type EngineNotification } from './EngineNotificationToasts'

const NOTIF: EngineNotification = { id: 'n1', message: 'hello', level: 'info', timestamp: 0 }

let container: HTMLDivElement
let root: Root
let onDismiss: ReturnType<typeof vi.fn>

function renderToasts() {
  act(() => {
    root.render(<EngineNotificationToasts notifications={[NOTIF]} onDismiss={onDismiss as (id: string) => void} />)
  })
}

function toastEl(): HTMLElement {
  const el = container.querySelector('[data-testid="toast"]')
  if (!el) throw new Error('toast not rendered')
  return el as HTMLElement
}

/** React synthesizes onMouseEnter/onMouseLeave from mouseover/mouseout. */
function hover(el: HTMLElement) {
  act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
}
function unhover(el: HTMLElement) {
  act(() => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
}

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

beforeEach(() => {
  vi.useFakeTimers()
  onDismiss = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('EngineNotificationToasts — auto-dismiss timer', () => {
  it('dismisses the toast after the 5s window', () => {
    renderToasts()
    advance(4999)
    expect(onDismiss).not.toHaveBeenCalled()
    advance(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('n1')
  })

  it('does NOT fire while hovered, however long the hover lasts (pause)', () => {
    renderToasts()
    advance(2000)
    hover(toastEl())
    // Way past the original 5s deadline — the paused toast must survive.
    advance(60_000)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('resumes with the remaining window after mouse-leave', () => {
    renderToasts()
    advance(2000) // 3000ms left
    const el = toastEl()
    hover(el)
    advance(10_000) // paused — consumes nothing
    unhover(el)
    advance(2999) // 1ms short of the remaining 3000
    expect(onDismiss).not.toHaveBeenCalled()
    advance(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('n1')
  })

  it('accumulates consumed time across repeated hovers', () => {
    renderToasts()
    const el = toastEl()
    advance(1000) // 4000 left
    hover(el)
    advance(5000)
    unhover(el)
    advance(1000) // 3000 left
    hover(el)
    advance(5000)
    unhover(el)
    expect(onDismiss).not.toHaveBeenCalled()
    advance(3000) // window exhausted
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
