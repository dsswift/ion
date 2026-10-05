// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'

const m = vi.hoisted(() => ({ copy: vi.fn(() => Promise.resolve()) }))

vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../theme', () => ({ useColors: () => ({}) }))
vi.mock('../../hooks/useAnchoredPopover', () => ({ useAnchoredPopover: () => ({ ref: () => {}, left: 0, top: 0, ready: true }) }))
vi.mock('../../hooks/useInteractiveState', () => ({ useInteractiveState: () => ({ hover: false, pressed: false, handlers: {} }), interactiveBg: () => 'transparent' }))
vi.mock('./surface-store', () => ({ useSurfaceStore: { getState: () => ({ pinnedTabs: [], currentConversationId: null, conversations: {} }) } }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({ activeTabId: 't1', tabs: [{ id: 't1', workingDirectory: '/repo' }] }) } }))
vi.mock('../../deeplink-client', () => ({ copyDeepLink: m.copy }))
vi.mock('../../rendererLogger', () => ({ rWarn: vi.fn() }))

import { SurfaceTabContextMenu } from './SurfaceTabContextMenu'

function render(tab: unknown): void {
  const root = createRoot(document.createElement('div'))
  act(() => root.render(React.createElement(SurfaceTabContextMenu, { x: 0, y: 0, tab: tab as never, onClose: () => {} })))
}

describe('SurfaceTabContextMenu Copy Link', () => {
  it('copies an ion://file link for a file tab, rooted at the conversation', () => {
    render({ id: 'f1', kind: 'file', filePath: '/repo/src/a.ts' })
    const item = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Copy Link')
    expect(item).toBeDefined()
    act(() => item!.click())
    expect(m.copy).toHaveBeenCalledWith('ion://file?dir=%2Frepo&path=%2Frepo%2Fsrc%2Fa.ts')
  })

  it('offers no Copy Link on a tab without a file', () => {
    document.body.innerHTML = ''
    render({ id: 'b1', kind: 'browser', instanceId: 'i1' })
    expect(Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent === 'Copy Link')).toBe(false)
  })
})
