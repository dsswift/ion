// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import React, { useRef } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rTrace: vi.fn() }))

import { useScrollFollow } from './useScrollFollow'

/**
 * Navigation-lock pins for the transcript scroll.
 *
 * THE BUG THESE EXIST FOR: clicking a chart row in the attachments panel
 * scrolled the transcript and was then immediately yanked back to the tail, so
 * the click looked like it did nothing — while the log reported a successful
 * jump.
 *
 * `pauseFollowing()` cleared the near-bottom flag before scrolling, but the
 * virtualizer's scroll is async: its scroll event ran `handleScroll`, which
 * re-marked "near bottom" because a chart is usually among the NEWEST rows and
 * the landing position fell inside the 80px tail threshold. Tail-following then
 * snapped the viewport back.
 *
 * `beginNavigation()` takes the viewport for the duration of the scroll so
 * neither resumption nor tail correction can run.
 */

interface Harness {
  api: ReturnType<typeof useScrollFollow>
  el: HTMLDivElement
}

function mount(): Harness {
  const captured: { api?: ReturnType<typeof useScrollFollow> } = {}
  const el = document.createElement('div')
  // A scrollable viewport whose content is taller than the box.
  Object.defineProperty(el, 'scrollHeight', { value: 5000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
  el.scrollTop = 4500 // at the tail

  function Probe() {
    const api = useScrollFollow([])
    const ref = useRef(false)
    if (!ref.current) {
      ref.current = true
      ;(api.scrollRef as { current: HTMLDivElement | null }).current = el
    }
    captured.api = api
    return null
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => { createRoot(host).render(React.createElement(Probe)) })
  return { api: captured.api!, el }
}

describe('useScrollFollow — navigation lock', () => {
  beforeEach(() => { document.body.replaceChildren() })

  it('does not re-arm tailing when a navigation lands inside the tail threshold', () => {
    const { api, el } = mount()

    // A chart is among the newest rows, so the jump lands within 80px of the
    // bottom. Before the lock, handleScroll saw "near bottom", set the flag
    // back to true, and the next content resize snapped the view to the tail.
    act(() => { api.beginNavigation() })
    el.scrollTop = 4460 // 40px from bottom — inside the 80px threshold
    act(() => { api.handleScroll() })

    expect(el.scrollTop).toBe(4460)
    // The flag is what the NEXT resize consults. Re-arming it is the defect.
    expect(api.isNearBottomRef.current).toBe(false)
  })

  it('keeps tailing suppressed for the whole navigation window', () => {
    const { api, el } = mount()
    act(() => { api.beginNavigation() })
    // Far from the tail: without the lock, handleScroll's correction branch
    // calls followTail and yanks the viewport to the bottom.
    el.scrollTop = 1200
    act(() => { api.handleScroll(); api.handleScroll(); api.handleScroll() })
    expect(el.scrollTop).toBe(1200)
  })

  it('still follows the tail during ordinary streaming', () => {
    // The lock must not disable normal tail-following, which is the behavior
    // the transcript depends on while a turn streams.
    const { api, el } = mount()
    el.scrollTop = 4490
    act(() => { api.handleScroll() })
    // Near bottom keeps tailing armed; a content grow snaps to the new end.
    act(() => { api.scrollToBottom() })
    expect(el.scrollTop).toBe(5000)
  })

  it('lets an explicit pause stop tailing without a navigation', () => {
    const { api, el } = mount()
    act(() => { api.pauseFollowing() })
    el.scrollTop = 800
    act(() => { api.handleScroll() })
    expect(el.scrollTop).toBe(800)
  })
})
