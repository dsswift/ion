// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const preferences = { keyboardShortcuts: { overlay: {}, studio: {} } }
vi.mock('../../preferences', () => ({ usePreferencesStore: { getState: () => preferences } }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rTrace: vi.fn(), rWarn: vi.fn() }))

import { useCommandShortcuts } from '../useCommandShortcuts'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement | null = null

function mount(view: 'overlay' | 'studio', handlers: Record<string, () => void>, capture = false): void {
  function Probe(): null {
    useCommandShortcuts({ view, handlers, capture })
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Probe />))
}

function key(keyName: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...options })
  act(() => window.dispatchEvent(event))
  return event
}

beforeEach(() => {
  preferences.keyboardShortcuts = { overlay: {}, studio: {} }
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
})

describe('useCommandShortcuts', () => {
  it('dispatches Studio Shift+Tab and consumes event', () => {
    const toggle = vi.fn()
    mount('studio', { 'permission.togglePlanAuto': toggle }, true)
    const event = key('Tab', { shiftKey: true })
    expect(toggle).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  it('uses Studio overrides without reading Overlay overrides', () => {
    const toggle = vi.fn()
    preferences.keyboardShortcuts = {
      overlay: { 'panel.statusDrawer': 'Mod+9' },
      studio: { 'panel.statusDrawer': 'Mod+8' },
    }
    mount('studio', { 'panel.statusDrawer': toggle }, true)
    key('9', { ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()
    key('8', { ctrlKey: true })
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('leaves a matched but unwired command available to focused control', () => {
    mount('studio', {}, true)
    const event = key('Tab', { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
  })
})
