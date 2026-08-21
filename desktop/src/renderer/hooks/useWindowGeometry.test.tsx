// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useElementHeight, useWindowHeight } from './useWindowGeometry'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

vi.mock('../preferences', () => ({
  usePreferencesStore: (selector: (state: { uiZoom: number }) => unknown) => selector({ uiZoom: 1.5 }),
}))

function WindowHeightHarness(): React.JSX.Element {
  const height = useWindowHeight()
  return <output data-height={height} />
}

function Harness({ elementRef, fallback }: {
  elementRef: React.RefObject<HTMLElement | null>
  fallback: number
}): React.JSX.Element {
  const height = useElementHeight(elementRef, fallback)
  return <output data-height={height} />
}

describe('useWindowHeight', () => {
  it('uses unscaled viewport CSS height', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<WindowHeightHarness />))
    expect(host.querySelector('output')?.dataset.height).toBe(String(window.innerHeight / 1.5))
    act(() => root.unmount())
    host.remove()
  })
})

describe('useElementHeight', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let originalResizeObserver: typeof ResizeObserver | undefined

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    FakeResizeObserver.instances = []
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver
    } else {
      Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
  })

  it('uses element height instead of taller browser viewport and follows host resize', () => {
    const element = document.createElement('div')
    let height = 320
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height,
      width: 400, height, toJSON: () => ({}),
    }))
    const elementRef = { current: element } as React.RefObject<HTMLElement | null>

    act(() => root.render(<Harness elementRef={elementRef} fallback={900} />))
    expect(host.querySelector('output')?.dataset.height).toBe('213.33333333333334')

    height = 460
    act(() => FakeResizeObserver.instances[0].trigger())
    expect(host.querySelector('output')?.dataset.height).toBe(String(460 / 1.5))

    height = 0
    act(() => FakeResizeObserver.instances[0].trigger())
    expect(host.querySelector('output')?.dataset.height).toBe(String(460 / 1.5))
  })

  it('keeps fallback until a zero-height host becomes measurable', () => {
    const element = document.createElement('div')
    let height = 0
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height,
      width: 400, height, toJSON: () => ({}),
    }))
    const elementRef = { current: element } as React.RefObject<HTMLElement | null>

    act(() => root.render(<Harness elementRef={elementRef} fallback={480} />))
    expect(host.querySelector('output')?.dataset.height).toBe('480')

    height = 360
    act(() => FakeResizeObserver.instances[0].trigger())
    expect(host.querySelector('output')?.dataset.height).toBe(String(360 / 1.5))
  })

  it('keeps fallback when no element is mounted', () => {
    const elementRef = { current: null } as React.RefObject<HTMLElement | null>

    act(() => root.render(<Harness elementRef={elementRef} fallback={480} />))

    expect(host.querySelector('output')?.dataset.height).toBe('480')
    expect(FakeResizeObserver.instances).toHaveLength(0)
  })

  it('disconnects observer on unmount', () => {
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 320,
      width: 400, height: 320, toJSON: () => ({}),
    })
    const elementRef = { current: element } as React.RefObject<HTMLElement | null>

    act(() => root.render(<Harness elementRef={elementRef} fallback={480} />))
    const observer = FakeResizeObserver.instances[0]
    act(() => root.unmount())
    expect(observer.disconnect).toHaveBeenCalledOnce()
  })
})
