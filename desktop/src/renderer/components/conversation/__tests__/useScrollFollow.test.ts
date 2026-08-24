// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { useScrollFollow } from '../useScrollFollow'

// Minimal hook runner without @testing-library/react. Works by rendering a
// tiny function component that captures the hook result into a mutable ref.
import React, { useState, type WheelEvent } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderScrollHook(initialDeps: unknown[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let result: ReturnType<typeof useScrollFollow>
  let setDeps: (d: unknown[]) => void

  function Harness() {
    const [deps, _setDeps] = useState(initialDeps)
    setDeps = _setDeps
    result = useScrollFollow(deps)
    return null
  }

  act(() => { root.render(React.createElement(Harness)) })

  return {
    get current() { return result! },
    update(newDeps: unknown[]) {
      act(() => { setDeps!(newDeps) })
    },
    unmount() {
      act(() => { root.unmount() })
      document.body.removeChild(container)
    },
  }
}

describe('useScrollFollow', () => {
  it('follows content growth while tailed and stops after the user scrolls up', () => {
    let notifyResize: ResizeObserverCallback | undefined
    const disconnect = vi.fn()
    const observe = vi.fn()
    const OriginalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(callback: ResizeObserverCallback) { notifyResize = callback }
      observe = observe
      unobserve = vi.fn()
      disconnect = disconnect
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let result: ReturnType<typeof useScrollFollow>
    function Harness() {
      result = useScrollFollow([0])
      return React.createElement('div', { ref: result.scrollRef },
        React.createElement('div', { ref: result.contentRef }))
    }

    act(() => { root.render(React.createElement(Harness)) })
    const scroll = result!.scrollRef.current!
    let scrollHeight = 500
    Object.defineProperty(scroll, 'scrollHeight', { get: () => scrollHeight, configurable: true })
    Object.defineProperty(scroll, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 400, configurable: true })
    expect(observe).toHaveBeenCalledWith(result!.contentRef.current)

    scrollHeight = 700
    act(() => { notifyResize?.([], {} as ResizeObserver) })
    expect(scroll.scrollTop).toBe(700)

    scroll.scrollTop = 0
    act(() => {
      result!.pauseFollowing()
      result!.handleScroll()
    })
    scrollHeight = 900
    act(() => { notifyResize?.([], {} as ResizeObserver) })
    expect(scroll.scrollTop).toBe(0)

    act(() => { root.unmount() })
    expect(disconnect).toHaveBeenCalled()
    document.body.removeChild(container)
    globalThis.ResizeObserver = OriginalResizeObserver
  })

  it('keeps tailing when virtual layout moves an opening conversation away from the bottom', () => {
    const hook = renderScrollHook([0])
    const div = document.createElement('div')
    Object.defineProperty(div, 'scrollHeight', { value: 10_000, configurable: true })
    Object.defineProperty(div, 'scrollTop', { value: 4_000, writable: true, configurable: true })
    Object.defineProperty(div, 'clientHeight', { value: 600, configurable: true })
    ;(hook.current.scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = div

    act(() => { hook.current.handleScroll() })

    expect(div.scrollTop).toBe(10_000)
    expect(hook.current.isNearBottomRef.current).toBe(true)
    expect(hook.current.showScrollBtn).toBe(false)
    hook.unmount()
  })

  it('stops tailing after user scroll intent and resumes when the user reaches the bottom', () => {
    const hook = renderScrollHook([0])
    const div = document.createElement('div')
    let scrollHeight = 1_000
    Object.defineProperty(div, 'scrollHeight', { get: () => scrollHeight, configurable: true })
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(div, 'clientHeight', { value: 400, configurable: true })
    ;(hook.current.scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = div

    act(() => {
      hook.current.handleWheel({ deltaY: -1 } as WheelEvent<HTMLDivElement>)
      hook.current.handleScroll()
    })
    expect(hook.current.isNearBottomRef.current).toBe(false)
    expect(hook.current.showScrollBtn).toBe(true)

    scrollHeight = 1_200
    hook.update([1])
    expect(div.scrollTop).toBe(0)

    div.scrollTop = 800
    act(() => { hook.current.handleScroll() })
    expect(hook.current.isNearBottomRef.current).toBe(true)
    expect(hook.current.showScrollBtn).toBe(false)

    scrollHeight = 1_400
    hook.update([2])
    expect(div.scrollTop).toBe(1_400)
    hook.unmount()
  })

  it('treats search navigation as an explicit break from tailing', () => {
    const hook = renderScrollHook([0])
    const div = document.createElement('div')
    Object.defineProperty(div, 'scrollHeight', { value: 1_000, configurable: true })
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(div, 'clientHeight', { value: 400, configurable: true })
    ;(hook.current.scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = div

    act(() => { window.dispatchEvent(new CustomEvent('ion:search-scrolled')) })
    hook.update([1])

    expect(div.scrollTop).toBe(0)
    expect(hook.current.isNearBottomRef.current).toBe(false)
    expect(hook.current.showScrollBtn).toBe(true)
    hook.unmount()
  })

  it('starts with showScrollBtn=false', () => {
    const hook = renderScrollHook([0])
    expect(hook.current.showScrollBtn).toBe(false)
    hook.unmount()
  })

  it('sets showScrollBtn when user scrolls away from bottom', () => {
    const hook = renderScrollHook([0])

    const div = document.createElement('div')
    Object.defineProperty(div, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(div, 'clientHeight', { value: 400, configurable: true })

    ;(hook.current.scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = div

    // Record real scroll input before the browser emits its scroll event.
    act(() => {
      hook.current.pauseFollowing()
      hook.current.handleScroll()
    })
    expect(hook.current.showScrollBtn).toBe(true)
    hook.unmount()
  })

  it('hides showScrollBtn when near bottom (within 80px)', () => {
    const hook = renderScrollHook([0])

    const div = document.createElement('div')
    Object.defineProperty(div, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(div, 'scrollTop', { value: 550, writable: true, configurable: true })
    Object.defineProperty(div, 'clientHeight', { value: 400, configurable: true })

    ;(hook.current.scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = div

    act(() => { hook.current.handleScroll() })

    // 1000 - 550 - 400 = 50 < 80
    expect(hook.current.showScrollBtn).toBe(false)
    hook.unmount()
  })

  it('scrollToBottom scrolls and hides button', () => {
    const hook = renderScrollHook([0])

    const div = document.createElement('div')
    Object.defineProperty(div, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(div, 'clientHeight', { value: 400, configurable: true })

    ;(hook.current.scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = div

    // Scroll away first
    act(() => {
      hook.current.pauseFollowing()
      hook.current.handleScroll()
    })
    expect(hook.current.showScrollBtn).toBe(true)

    // Then scrollToBottom
    act(() => { hook.current.scrollToBottom() })

    expect(div.scrollTop).toBe(1000)
    expect(hook.current.showScrollBtn).toBe(false)
    hook.unmount()
  })

  it('auto-tails when deps change and user is near bottom', () => {
    const hook = renderScrollHook([0])

    const div = document.createElement('div')
    Object.defineProperty(div, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(div, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(div, 'clientHeight', { value: 400, configurable: true })

    ;(hook.current.scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = div

    // isNearBottomRef defaults to true, so auto-tail fires on dep change
    hook.update([1])

    expect(div.scrollTop).toBe(500)
    hook.unmount()
  })
})
