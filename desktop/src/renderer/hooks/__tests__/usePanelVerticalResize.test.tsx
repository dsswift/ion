// @vitest-environment jsdom
//
// usePanelVerticalResize — dragging a bottom-anchored panel's top edge.
//
// The panels grow UPWARD, so a negative dy (cursor moving up) means taller.
// That inversion is the part worth pinning: getting it backwards would make the
// handle shrink the panel when pulled, which reads as a broken control rather
// than a wrong number.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { usePanelVerticalResize, resolveDragHeight } from '../usePanelVerticalResize'
import { defaultPanelHeight, maxPanelHeight } from '../../components/panelGeometry'

describe('resolveDragHeight — pure arithmetic', () => {
  it('grows on a negative dy, because up means taller', () => {
    expect(resolveDragHeight(482, -120, 482, 1200)).toBe(602)
  })

  it('shrinks on a positive dy', () => {
    expect(resolveDragHeight(700, 100, 482, 1200)).toBe(600)
  })

  it('pins at the floor rather than going below it', () => {
    expect(resolveDragHeight(482, 400, 482, 1200)).toBe(482)
  })

  it('pins at the ceiling rather than going above it', () => {
    expect(resolveDragHeight(1100, -400, 482, 1200)).toBe(1200)
  })
})

const HANDLE = '[data-testid="test-panel-resize-handle"]'

function Harness({ onCommit }: { onCommit(h: number | null): void }): React.JSX.Element {
  const { height, renderHandle } = usePanelVerticalResize({
    panelId: 'test-panel',
    expandedUI: false,
    override: null,
    onCommit,
  })
  return React.createElement('div', { 'data-testid': 'panel', 'data-height': String(height) }, renderHandle())
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const onCommit = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(React.createElement(Harness, { onCommit })) })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.style.cursor = ''
})

/**
 * One complete drag: press, move, release.
 *
 * Releasing matters even in tests that only assert the committed value -- the
 * hook attaches its listeners to `document`, so an unreleased drag stays live
 * and the NEXT drag's moves reach both handlers.
 */
function drag(dy: number): void {
  act(() => {
    host.querySelector(HANDLE)!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 500 }))
  })
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 500 + dy }))
  })
  act(() => { document.dispatchEvent(new MouseEvent('mouseup')) })
}

describe('usePanelVerticalResize — the drag', () => {
  it('renders at the default height with no override', () => {
    expect(host.querySelector('[data-testid="panel"]')!.getAttribute('data-height'))
      .toBe(String(defaultPanelHeight(false)))
  })

  it('commits default + 120 when dragged 120px upward', () => {
    drag(-120)
    expect(onCommit).toHaveBeenLastCalledWith(defaultPanelHeight(false) + 120)
  })

  it('commits exactly the default when dragged far downward, never less', () => {
    drag(400)
    expect(onCommit).toHaveBeenLastCalledWith(defaultPanelHeight(false))
  })

  it('stops at the viewport ceiling on a very large upward drag', () => {
    drag(-5000)
    const ceiling = maxPanelHeight(window.innerHeight, defaultPanelHeight(false))
    expect(onCommit).toHaveBeenLastCalledWith(ceiling)
  })

  it('commits on every move so the edge tracks the cursor', () => {
    // Committing only on mouseup would make the panel snap on release rather
    // than follow the drag -- the convention usePaneSash already established.
    act(() => {
      host.querySelector(HANDLE)!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 500 }))
    })
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientY: 460 })) })
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientY: 420 })) })

    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenNthCalledWith(1, defaultPanelHeight(false) + 40)
    expect(onCommit).toHaveBeenNthCalledWith(2, defaultPanelHeight(false) + 80)
  })

  it('releases the cursor override and stops committing after mouseup', () => {
    drag(-100)
    const callsAtRelease = onCommit.mock.calls.length

    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientY: 100 })) })

    expect(onCommit).toHaveBeenCalledTimes(callsAtRelease)
    expect(document.body.style.cursor).toBe('')
  })
})
