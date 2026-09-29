// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTrayMenuListeners } from './useTrayMenuListeners'

const { onShowSettings, capabilities } = vi.hoisted(() => ({
  onShowSettings: vi.fn(() => vi.fn()),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../host/host-instance', () => ({ host: { capabilities, shell: { onShowSettings } } }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ openSettings: vi.fn() }) },
}))

function Probe(): React.ReactElement {
  useTrayMenuListeners()
  return React.createElement('div')
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onShowSettings.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useTrayMenuListeners', () => {
  it('does not subscribe without the tray capability (browser Studio client)', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    act(() => root.render(React.createElement(Probe)))
    expect(onShowSettings).not.toHaveBeenCalled()
  })

  it('subscribes when the host reports the tray capability (Electron)', () => {
    capabilities.mockReturnValue(['tray'])
    act(() => root.render(React.createElement(Probe)))
    expect(onShowSettings).toHaveBeenCalledTimes(1)
  })
})
