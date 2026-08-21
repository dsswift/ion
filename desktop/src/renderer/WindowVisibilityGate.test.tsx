// @vitest-environment jsdom
/**
 * WindowVisibilityGate pins the regression this component exists to fix: a
 * hidden/minimized window kept ticking `infinite` CSS animations forever,
 * which showed up as sustained GPU cost from a window with no pixels on
 * screen. The fix is the `.ion-window-hidden` class toggle driven by
 * document.visibilitychange — this test asserts the toggle happens both
 * ways without touching real timers or Electron IPC.
 */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WindowVisibilityGate } from './WindowVisibilityGate'

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('WindowVisibilityGate', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    document.documentElement.classList.remove('ion-window-hidden')
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container)
      root.render(<WindowVisibilityGate />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.documentElement.classList.remove('ion-window-hidden')
  })

  it('adds ion-window-hidden when the window becomes hidden', () => {
    act(() => setVisibility('hidden'))
    expect(document.documentElement.classList.contains('ion-window-hidden')).toBe(true)
  })

  it('removes ion-window-hidden when the window becomes visible again', () => {
    act(() => setVisibility('hidden'))
    expect(document.documentElement.classList.contains('ion-window-hidden')).toBe(true)

    act(() => setVisibility('visible'))
    expect(document.documentElement.classList.contains('ion-window-hidden')).toBe(false)
  })

  it('does not mark the window hidden on mount when it starts visible', () => {
    expect(document.documentElement.classList.contains('ion-window-hidden')).toBe(false)
  })
})
