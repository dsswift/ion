// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const find = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../components/git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}))
vi.mock('../../../host/host-instance', () => ({ host: { shell: { studioBrowserFind: find }, capabilities: () => ['browser'] } }))

import { BrowserFindBar } from './BrowserFindBar'

let container: HTMLDivElement
let root: Root
const onClose = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  find.mockClear()
  onClose.mockClear()
})
afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

function mount(matches: { activeMatchOrdinal: number; matches: number } | null): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(BrowserFindBar, { conversationId: 'c1', instanceId: 'i1', matches, focusNonce: 1, onClose }))
  })
}
function input(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input')!
}
function type(text: string): void {
  const el = input()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('BrowserFindBar', () => {
  it('searches on every keystroke and steps on Enter and Shift+Enter', () => {
    mount(null)
    expect(document.activeElement).toBe(input())
    type('needle')
    expect(find).toHaveBeenLastCalledWith('c1', 'i1', { text: 'needle', forward: true, findNext: false })
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(find).toHaveBeenLastCalledWith('c1', 'i1', { text: 'needle', forward: true, findNext: true })
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })) })
    expect(find).toHaveBeenLastCalledWith('c1', 'i1', { text: 'needle', forward: false, findNext: true })
  })

  it('shows the ordinal and count, and stops the search on unmount', () => {
    mount({ activeMatchOrdinal: 2, matches: 7 })
    type('x')
    expect(container.querySelector('[aria-label="Find matches"]')?.textContent).toBe('2/7')
    act(() => root.unmount())
    expect(find).toHaveBeenLastCalledWith('c1', 'i1', { stop: true })
  })

  it('closes on Escape', () => {
    mount(null)
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
