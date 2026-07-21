// @vitest-environment jsdom
//
// Interaction test for the WorkspaceStatusIndicator popover's clickable tab
// names. Pins the navigation behavior end-to-end: opening the popover renders
// a running tab's name as a button, clicking it calls selectTab with that tab's
// id and closes the popover. Reverting the row's onClick wiring makes this red.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => {
  const selectTab = vi.fn()
  const tabs = [
    { id: 'run-1', status: 'running', title: 'Runner', customTitle: null, isTerminalOnly: false, bashExecuting: false, hasUnread: false },
    { id: 'idle-1', status: 'idle', title: 'Idler', customTitle: null, isTerminalOnly: false, bashExecuting: false, hasUnread: false },
  ]
  const storeState: any = { tabs, conversationPanes: new Map(), selectTab }
  // useSessionStore is used two ways: as a hook selector `useSessionStore(sel)`
  // and as `useSessionStore.getState()`. Support both.
  const useSessionStore: any = (sel: (s: any) => unknown) => sel(storeState)
  useSessionStore.getState = () => storeState
  return { selectTab, useSessionStore }
})

vi.mock('../../stores/sessionStore', () => ({ useSessionStore: h.useSessionStore }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('@phosphor-icons/react', () => ({}))
vi.mock('../../stores/conversation-instance', () => ({
  activeInstance: () => ({ permissionQueue: [] }),
}))
vi.mock('../TabStripShared', () => ({
  anyEngineInstanceHasRunningChildren: () => false,
  getWaitingState: () => null,
}))
// Portal target: render popover + tooltip content into the test container's body.
vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => document.body,
}))

import { WorkspaceStatusIndicator } from '../WorkspaceStatusIndicator'

describe('WorkspaceStatusIndicator popover navigation', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    h.selectTab.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('clicking a running tab name calls selectTab and closes the popover', () => {
    act(() => { root.render(React.createElement(WorkspaceStatusIndicator)) })

    // Open the popover by clicking the status dot button.
    const dot = container.querySelector('button') as HTMLButtonElement
    act(() => { dot.click() })

    // The running tab name is rendered as a clickable button; the idle tab is not.
    const nameButtons = Array.from(document.body.querySelectorAll('button')).filter(
      (b) => b.textContent === 'Runner',
    )
    expect(nameButtons.length).toBe(1)
    expect(Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent === 'Idler')).toBe(false)

    // The popover root must carry data-ion-ui so useClickThrough disables OS
    // click-through over it. Without this the transparent overlay stays in
    // pass-through mode and every click on the popover hits the app behind the
    // glass instead of the tab-name rows. The name button must resolve to a
    // data-ion-ui ancestor.
    expect((nameButtons[0] as HTMLElement).closest('[data-ion-ui]')).not.toBeNull()

    // Real click sequence is mousedown → (browser processes it) → mouseup →
    // click. The document-level outside-click handler listens on mousedown; the
    // popover portals into a layer OUTSIDE the dot button. If mousedown on the
    // row is treated as an outside click it fires setOpen(false), React unmounts
    // the row, and the subsequent native click lands on nothing — navigation
    // silently drops. Flush React AFTER mousedown (separate act) to reproduce the
    // real unmount timing, then assert the row survived and the click navigates.
    const row = nameButtons[0] as HTMLButtonElement
    act(() => { row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    // Row must still be mounted after mousedown flush — the guard's whole job.
    expect(document.body.contains(row)).toBe(true)
    act(() => { row.click() })
    expect(h.selectTab).toHaveBeenCalledWith('run-1')

    // Popover closed → the name row is gone.
    expect(Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent === 'Runner')).toBe(false)
  })
})
