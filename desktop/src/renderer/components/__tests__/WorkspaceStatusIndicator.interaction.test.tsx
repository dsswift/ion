// @vitest-environment jsdom
//
// Interaction tests for the WorkspaceStatusIndicator popover.
//
//   1. Clickable tab names — pins navigation end-to-end: opening the popover
//      renders a running tab's name as a button, clicking it calls selectTab
//      with that tab's id and closes the popover. Reverting the row's onClick
//      wiring makes this red.
//   2. Collapsible idle-ish categories — pins collapsed-by-default, header
//      toggle expansion, navigation from an expanded category, and process-
//      sticky expansion (survives popover close/reopen; reset seam clears it).
//   3. Mode glyphs — pins that a plan-mode tab renders the plan glyph and an
//      auto-mode tab renders the build glyph on its name row.
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
    { id: 'q-1', status: 'idle', title: 'Asker', customTitle: null, isTerminalOnly: false, bashExecuting: false, hasUnread: false },
  ]
  // q-1 waits on a question (idle-ish bucket); run-1 is in plan mode.
  const waitingStates = new Map<string, 'question' | 'plan-ready' | null>([['q-1', 'question']])
  const permissionModes = new Map<string, 'plan' | 'auto'>([['run-1', 'plan']])
  const storeState: any = { tabs, conversationPanes: new Map(), selectTab }
  // useSessionStore is used two ways: as a hook selector `useSessionStore(sel)`
  // and as `useSessionStore.getState()`. Support both.
  const useSessionStore: any = (sel: (s: any) => unknown) => sel(storeState)
  useSessionStore.getState = () => storeState
  return { selectTab, useSessionStore, waitingStates, permissionModes }
})

vi.mock('../../stores/sessionStore', () => ({ useSessionStore: h.useSessionStore }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
// Mode glyphs must be identifiable in the DOM: stub each icon as a span
// carrying a data-icon marker so assertions can tell plan from build.
vi.mock('@phosphor-icons/react', () => ({
  ListChecks: (props: any) => React.createElement('span', { 'data-icon': 'list-checks', ...props }),
  Robot: (props: any) => React.createElement('span', { 'data-icon': 'robot', ...props }),
  CaretRight: (props: any) => React.createElement('span', { 'data-icon': 'caret-right', ...props }),
}))
vi.mock('../../stores/conversation-instance', () => ({
  activeInstance: () => ({ permissionQueue: [] }),
  effectivePermissionMode: (tab: { id: string }) => h.permissionModes.get(tab.id) ?? 'auto',
}))
vi.mock('../TabStripShared', () => ({
  anyEngineInstanceHasRunningChildren: () => false,
  anyEngineInstanceHasRunningShells: () => false,
  isAnyTerminalCommandRunning: () => false,
  getWaitingState: (tab: any) => h.waitingStates.get(tab.id) ?? null,
}))
// Portal target: render popover + tooltip content into the test container's body.
vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => document.body,
}))

import { WorkspaceStatusIndicator, resetWorkspaceCategoryExpansion } from '../WorkspaceStatusIndicator'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function allButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('button'))
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return allButtons().find((b) => b.textContent === text)
}

/** The collapsible category header button (contains label + count + chevron). */
function categoryHeader(label: string): HTMLButtonElement | undefined {
  return allButtons().find((b) => b.textContent?.includes(label) && b.hasAttribute('aria-expanded'))
}

describe('WorkspaceStatusIndicator popover', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    h.selectTab.mockClear()
    // Sticky expansion is module-level state; clear it so cases stay
    // order-independent.
    resetWorkspaceCategoryExpansion()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function openPopover() {
    const dot = container.querySelector('button') as HTMLButtonElement
    act(() => { dot.click() })
    return dot
  }

  function closePopover(dot: HTMLButtonElement) {
    act(() => { dot.click() })
  }

  it('clicking a running tab name calls selectTab and closes the popover', () => {
    act(() => { root.render(React.createElement(WorkspaceStatusIndicator)) })

    openPopover()

    // The running tab name is rendered as a clickable button; the idle tab is not.
    const nameButtons = allButtons().filter((b) => b.textContent?.includes('Runner'))
    expect(nameButtons.length).toBe(1)
    expect(allButtons().some((b) => b.textContent?.includes('Idler'))).toBe(false)

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
    const row = nameButtons[0]
    act(() => { row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    // Row must still be mounted after mousedown flush — the guard's whole job.
    expect(document.body.contains(row)).toBe(true)
    act(() => { row.click() })
    expect(h.selectTab).toHaveBeenCalledWith('run-1')

    // Popover closed → the name row is gone.
    expect(allButtons().some((b) => b.textContent?.includes('Runner'))).toBe(false)
  })

  it('idle-ish categories render collapsed by default: count visible, names absent', () => {
    act(() => { root.render(React.createElement(WorkspaceStatusIndicator)) })
    openPopover()

    // Question header shows with its count…
    const header = categoryHeader('Question')
    expect(header).toBeDefined()
    expect(header!.getAttribute('aria-expanded')).toBe('false')
    expect(header!.textContent).toContain('1')
    // …but the tab name inside it is not rendered.
    expect(allButtons().some((b) => b.textContent?.includes('Asker'))).toBe(false)
    // Idle category collapsed too.
    expect(allButtons().some((b) => b.textContent?.includes('Idler'))).toBe(false)
  })

  it('clicking a category header expands it; clicking a revealed name navigates', () => {
    act(() => { root.render(React.createElement(WorkspaceStatusIndicator)) })
    openPopover()

    act(() => { categoryHeader('Question')!.click() })
    expect(categoryHeader('Question')!.getAttribute('aria-expanded')).toBe('true')

    const name = buttonWithText('Asker') ?? allButtons().find((b) => b.textContent?.includes('Asker'))
    expect(name).toBeDefined()
    act(() => { name!.click() })
    expect(h.selectTab).toHaveBeenCalledWith('q-1')
    // Popover closed after navigation.
    expect(allButtons().some((b) => b.textContent?.includes('Asker'))).toBe(false)
  })

  it('expansion is sticky across popover close/reopen; collapse is sticky too', () => {
    act(() => { root.render(React.createElement(WorkspaceStatusIndicator)) })

    // Expand Question, close popover.
    const dot = openPopover()
    act(() => { categoryHeader('Question')!.click() })
    closePopover(dot)
    expect(allButtons().some((b) => b.textContent?.includes('Asker'))).toBe(false)

    // Reopen: still expanded, name visible without another toggle.
    openPopover()
    expect(categoryHeader('Question')!.getAttribute('aria-expanded')).toBe('true')
    expect(allButtons().some((b) => b.textContent?.includes('Asker'))).toBe(true)

    // Collapse it, close, reopen: collapsed again.
    act(() => { categoryHeader('Question')!.click() })
    closePopover(dot)
    openPopover()
    expect(categoryHeader('Question')!.getAttribute('aria-expanded')).toBe('false')
    expect(allButtons().some((b) => b.textContent?.includes('Asker'))).toBe(false)
  })

  it('renders the plan glyph for a plan-mode tab and the build glyph for auto', () => {
    act(() => { root.render(React.createElement(WorkspaceStatusIndicator)) })
    openPopover()

    // run-1 is plan mode → its always-visible name row carries the plan glyph.
    const runnerRow = allButtons().find((b) => b.textContent?.includes('Runner'))!
    expect(runnerRow.querySelector('[data-icon="list-checks"]')).not.toBeNull()
    expect(runnerRow.querySelector('[data-icon="robot"]')).toBeNull()

    // q-1 is auto (build) mode → expand its category and check the robot glyph.
    act(() => { categoryHeader('Question')!.click() })
    const askerRow = allButtons().find((b) => b.textContent?.includes('Asker'))!
    expect(askerRow.querySelector('[data-icon="robot"]')).not.toBeNull()
    expect(askerRow.querySelector('[data-icon="list-checks"]')).toBeNull()
  })
})
