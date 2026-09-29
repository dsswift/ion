// @vitest-environment jsdom
/**
 * useFileEditorPanel — restore-clamp behavior.
 *
 * When geometry is restored from the session store (e.g. saved on a large
 * external monitor), it must be clamped to the current viewport before being
 * applied to the panel DOM. This pins the monitor→laptop narrow-and-clamp
 * case: a 1600×900 panel at x=1800 on an 800×600 viewport must land fully
 * on-screen and no larger than the viewport.
 *
 * The hook mutates panelRef.current's style directly on restore, so we render
 * the hook, attach a real div to panelRef, and read back the applied
 * left/top/width/height.
 */
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useFileEditorPanel } from '../useFileEditorPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Store mock ──────────────────────────────────────────────────────────────
// The hook subscribes to editorGeometry and calls setEditorGeometry on the
// store's getState(). We provide a minimal mock that returns a fixed,
// oversized/off-screen geometry so the restore effect exercises the clamp.

const RESTORED_GEO = { x: 1800, y: 40, w: 1600, h: 900 }

vi.mock('@ion/server/store/sessionStore', () => {
  const state = {
    editorGeometry: { x: 1800, y: 40, w: 1600, h: 900 },
    setEditorGeometry: vi.fn(),
  }
  const useSessionStore = (sel: (s: typeof state) => unknown) => sel(state)
  ;(useSessionStore as unknown as { getState: () => typeof state }).getState = () => state
  return { useSessionStore }
})

function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, writable: true, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, writable: true, configurable: true })
}

function renderPanelHook() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let result: ReturnType<typeof useFileEditorPanel>

  function Harness() {
    result = useFileEditorPanel()
    // Attach a real element so the restore effect can mutate its style.
    return React.createElement('div', { ref: result.panelRef })
  }

  act(() => {
    root.render(React.createElement(Harness))
  })

  return {
    get current() {
      return result!
    },
    get el(): HTMLDivElement {
      return container.firstElementChild as HTMLDivElement
    },
    unmount() {
      act(() => root.unmount())
      document.body.removeChild(container)
    },
  }
}

describe('useFileEditorPanel — restore clamp', () => {
  it('clamps oversized/off-screen restored geometry to the viewport', () => {
    setViewport(800, 600)
    const hook = renderPanelHook()

    // Sanity: the fixture is intentionally larger than the viewport.
    expect(RESTORED_GEO.w).toBeGreaterThan(800)
    expect(RESTORED_GEO.x + RESTORED_GEO.w).toBeGreaterThan(800)

    const el = hook.el
    const left = parseFloat(el.style.left)
    const top = parseFloat(el.style.top)
    const width = parseFloat(el.style.width)
    const height = parseFloat(el.style.height)

    // Width/height within viewport dimensions.
    expect(width).toBeLessThanOrEqual(800)
    expect(height).toBeLessThanOrEqual(600)

    // Position on-screen: fully within the viewport bounds.
    expect(left).toBeGreaterThanOrEqual(0)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(left + width).toBeLessThanOrEqual(800)
    expect(top + height).toBeLessThanOrEqual(600)

    // Reported size state matches the clamped geometry.
    expect(hook.current.size.w).toBe(width)
    expect(hook.current.size.h).toBe(height)

    hook.unmount()
  })
})
