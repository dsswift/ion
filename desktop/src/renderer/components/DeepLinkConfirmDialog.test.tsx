// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { setDeepLinkConfirmAvailability, onDeepLinkConfirmSettled, onDeepLinkConfirmRequest, capabilities } = vi.hoisted(() => ({
  setDeepLinkConfirmAvailability: vi.fn(),
  onDeepLinkConfirmSettled: vi.fn(() => vi.fn()),
  onDeepLinkConfirmRequest: vi.fn(() => vi.fn()),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../host/host-instance', () => ({
  host: {
    capabilities,
    shell: { setDeepLinkConfirmAvailability, onDeepLinkConfirmSettled, onDeepLinkConfirmRequest },
  },
}))
vi.mock('../theme', () => ({ useColors: () => ({}) }))
vi.mock('./PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: (selector: (s: { tabs: unknown[] }) => unknown) => selector({ tabs: [] }) }))
vi.mock('@ion/server/lib/window-role', () => ({ isMirrorWindow: () => true }))
vi.mock('../rendererLogger', () => ({ rInfo: vi.fn() }))

import { DeepLinkConfirmDialog } from './DeepLinkConfirmDialog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setDeepLinkConfirmAvailability.mockClear()
  onDeepLinkConfirmSettled.mockClear()
  onDeepLinkConfirmRequest.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('DeepLinkConfirmDialog', () => {
  it('does not touch host.shell without the deeplink capability (browser Studio client)', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    act(() => root.render(React.createElement(DeepLinkConfirmDialog)))
    expect(setDeepLinkConfirmAvailability).not.toHaveBeenCalled()
    expect(onDeepLinkConfirmSettled).not.toHaveBeenCalled()
    expect(onDeepLinkConfirmRequest).not.toHaveBeenCalled()
  })

  it('registers availability and listeners when the host reports the deeplink capability (Electron)', () => {
    capabilities.mockReturnValue(['deeplink'])
    act(() => root.render(React.createElement(DeepLinkConfirmDialog)))
    expect(setDeepLinkConfirmAvailability).toHaveBeenCalledWith('studio', true)
    expect(onDeepLinkConfirmSettled).toHaveBeenCalledTimes(1)
    expect(onDeepLinkConfirmRequest).toHaveBeenCalledTimes(1)
  })

  it('shows the launch key, so the operator knows an existing pane will be stopped and reused', () => {
    capabilities.mockReturnValue(['deeplink'])
    act(() => root.render(React.createElement(DeepLinkConfirmDialog)))
    const deliver = (onDeepLinkConfirmRequest.mock.calls[0] as unknown as [(request: unknown) => void])[0]
    act(() => deliver({ id: 'dl-1', owner: 'studio', action: 'terminal', tabId: 'tab-a', title: 'api', cmd: 'npm run dev', key: 'dev.yaml/abc/api' }))

    expect(document.body.textContent).toContain('dev.yaml/abc/api')
    expect(document.body.textContent).toContain('stopped and reused')
  })
})
