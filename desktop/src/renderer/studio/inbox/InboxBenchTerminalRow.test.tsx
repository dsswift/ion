// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pinTab = vi.fn(() => true)
const unpinTab = vi.fn()
const selectTab = vi.fn()
const closeTab = vi.fn()
const state = {
  activeTabId: 'outside',
  tabs: [] as TabState[],
  terminalActivities: new Set<string>(),
  pinTab,
  unpinTab,
  selectTab,
  closeTab,
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../rendererLogger', () => ({ rWarn: vi.fn() }))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => null }))

import { InboxBenchTerminalRow } from './InboxBenchTerminalRow'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(pinnedAt: number | null): HTMLElement {
  state.tabs = [{
    id: 'bench-terminal', title: 'Terminal', customTitle: 'Bench · main', status: 'idle',
    workingDirectory: '/bench/main', isTerminalOnly: true, pinnedAt,
  } as TabState]
  act(() => root.render(<InboxBenchTerminalRow tabId="bench-terminal" sourceBranch="main" label="Bench · main" />))
  return host.querySelector<HTMLElement>('[data-testid="inbox-bench-terminal-main"]')!
}

function openMenu(row: HTMLElement): HTMLButtonElement[] {
  act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
  return [...host.querySelectorAll('button')]
}

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('InboxBenchTerminalRow pin actions', () => {
  it('pins without selecting or closing the terminal', () => {
    const row = render(null)
    expect(row.querySelector('[data-testid="bench-terminal-pin"]')).toBeNull()
    const pin = openMenu(row).find((button) => button.textContent === 'Pin terminal')
    expect(pin).toBeDefined()
    act(() => { pin!.click() })
    expect(pinTab).toHaveBeenCalledWith('bench-terminal')
    expect(selectTab).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('shows a marker and unpins without selecting or closing', () => {
    const row = render(10)
    expect(row.querySelector('[data-testid="bench-terminal-pin"]')).not.toBeNull()
    const unpin = openMenu(row).find((button) => button.textContent === 'Unpin terminal')
    expect(unpin).toBeDefined()
    act(() => { unpin!.click() })
    expect(unpinTab).toHaveBeenCalledWith('bench-terminal')
    expect(selectTab).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })
})
