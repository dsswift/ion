// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { onStudioWindowChrome, studioSetTitleBarOverlay, capabilities } = vi.hoisted(() => ({
  onStudioWindowChrome: vi.fn(() => vi.fn()),
  studioSetTitleBarOverlay: vi.fn(() => Promise.resolve(true)),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../host/host-instance', () => ({
  host: { capabilities, shell: { platform: 'linux', onStudioWindowChrome, studioSetTitleBarOverlay } },
}))
vi.mock('../../rendererLogger', () => ({ rWarn: vi.fn() }))

import { useStudioWindowChrome } from './useStudioWindowChrome'

const COLORS = { containerBgCollapsed: '#000', containerBg: '#111', textSecondary: '#fff' } as any

let lastInset: { left: number; right: number } | null = null

function Probe(): React.ReactElement {
  lastInset = useStudioWindowChrome(COLORS)
  return React.createElement('div')
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onStudioWindowChrome.mockClear()
  studioSetTitleBarOverlay.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useStudioWindowChrome without the nativeWindowChrome capability (browser Studio client)', () => {
  it('does not subscribe to fullscreen state or set the title bar overlay', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    act(() => root.render(React.createElement(Probe)))
    expect(onStudioWindowChrome).not.toHaveBeenCalled()
    expect(studioSetTitleBarOverlay).not.toHaveBeenCalled()
  })

  it('reserves no window-control inset, so title-bar buttons reach the window edge', () => {
    // Regression pin: `unsupportedShell()` reports `platform: 'linux'`, so the
    // non-darwin branch used to reserve a Windows-sized control strip on the
    // right of a browser tab that has no native controls at all -- the title
    // bar's notification/terminal/surface buttons stopped well short of the
    // right edge.
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    act(() => root.render(React.createElement(Probe)))
    expect(lastInset).toEqual({ left: 0, right: 0 })
  })
})

describe('useStudioWindowChrome with the nativeWindowChrome capability (Electron)', () => {
  it('subscribes to fullscreen state and sets the title bar overlay', () => {
    capabilities.mockReturnValue(['nativeWindowChrome'])
    act(() => root.render(React.createElement(Probe)))
    expect(onStudioWindowChrome).toHaveBeenCalledTimes(1)
    expect(studioSetTitleBarOverlay).toHaveBeenCalledTimes(1)
  })

  it('still reserves the native control inset', () => {
    capabilities.mockReturnValue(['nativeWindowChrome'])
    act(() => root.render(React.createElement(Probe)))
    expect(lastInset!.right).toBeGreaterThan(0)
  })
})
