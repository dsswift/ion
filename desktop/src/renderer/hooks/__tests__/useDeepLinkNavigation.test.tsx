// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'

const m = vi.hoisted(() => ({ open: vi.fn(() => Promise.resolve()), capabilities: vi.fn<() => string[]>(() => []) }))

vi.mock('../../deeplink-client', () => ({ openDeepLinkUrl: m.open, navigateToDeepLinkTarget: vi.fn() }))
vi.mock('../../host/host-instance', () => ({ host: { capabilities: m.capabilities, shell: {} } }))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))

import { useDeepLinkNavigation } from '../useDeepLinkNavigation'

function Probe({ ready }: { ready: boolean }): null {
  useDeepLinkNavigation(ready)
  return null
}

describe('useDeepLinkNavigation in a browser', () => {
  it('opens an /open/... page path once ready and clears it from the address bar', () => {
    window.history.replaceState(null, '', '/open/conversation?id=c1')
    const root = createRoot(document.createElement('div'))
    act(() => root.render(React.createElement(Probe, { ready: false })))
    expect(m.open).not.toHaveBeenCalled()

    act(() => root.render(React.createElement(Probe, { ready: true })))
    expect(m.open).toHaveBeenCalledWith('ion://conversation?id=c1')
    expect(window.location.pathname).toBe('/')
    act(() => root.unmount())
  })
})
