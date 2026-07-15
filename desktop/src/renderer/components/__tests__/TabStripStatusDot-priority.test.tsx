// @vitest-environment jsdom
/**
 * Tests for the StatusDot component's priority cascade —
 * specifically that hasRunningChildren (yellow) outranks
 * waitingState === 'plan-ready' (green).
 *
 * These tests MUST go RED if the reorder in TabStripStatusDot.tsx is
 * undone (i.e. if the plan-ready branch is moved above the
 * hasRunningChildren branch).
 *
 * Pure rendering test — no store, no IPC, no Electron. StatusDot takes
 * all state as explicit props so we can drive every branch directly
 * without a store mock.
 */

import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// --- Mocks ---------------------------------------------------------------

vi.mock('@phosphor-icons/react', () => ({
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ conversationPanes: new Map() }),
    subscribe: () => () => {},
  },
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1, gitOpsMode: 'standard' }) },
}))

// useColors returns deterministic, CSS-valid hex colors so jsdom can accept
// them via style.background. Each token has a unique value so assertions
// distinguish branches. The factory is inlined (not referencing a hoisted
// variable) because vi.mock calls are hoisted above module scope.
vi.mock('../../theme', () => ({
  useColors: () => ({
    statusIdle:                '#010101',
    statusError:               '#020202',
    statusPermission:          '#030303',
    statusPermissionGlow:      '#040404',
    statusRunning:             '#050505',
    statusWaitingChildren:     '#060606',
    statusWaitingChildrenGlow: '#070707',
    statusComplete:            '#080808',
    tabGlowPlanReady:          '#090909',
    infoText:                  '#0a0a0a',
    tabGlowQuestion:           '#0b0b0b',
    statusBash:                '#0c0c0c',
    statusBashGlow:            '#0d0d0d',
  }),
}))

// --- Import after mocks --------------------------------------------------

import { StatusDot } from '../TabStripStatusDot'

// --- Color constants (mirror of the mock above) --------------------------
// Defined after import; not used inside vi.mock factories.

const C = {
  statusIdle:                '#010101',
  statusRunning:             '#050505',
  statusWaitingChildren:     '#060606',
  statusComplete:            '#080808',
} as const

// --- Helpers -------------------------------------------------------------

/** Convert a 6-digit hex color (#rrggbb) to the rgb() string jsdom produces. */
function hex2rgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgb(${r}, ${g}, ${b})`
}

/** Mount StatusDot into a fresh div, return the background color of the dot span. */
function renderDotColor(props: React.ComponentProps<typeof StatusDot>): string {
  const div = document.createElement('div')
  document.body.appendChild(div)
  divsToCleanup.push(div)
  const root = createRoot(div)
  act(() => { root.render(React.createElement(StatusDot, props)) })
  // StatusDot renders a span with inline style. jsdom normalizes hex to rgb().
  const span = div.querySelector('span[style]') as HTMLElement | null
  return span?.style.background ?? ''
}

// Base "neutral idle" props — no state active.
const BASE: React.ComponentProps<typeof StatusDot> = {
  status: 'idle',
  hasUnread: false,
  hasPermission: false,
  bashExecuting: false,
  waitingState: null,
  pillIcon: null,
  hasRunningChildren: false,
}

const divsToCleanup: HTMLElement[] = []

afterEach(() => {
  while (divsToCleanup.length) divsToCleanup.pop()?.remove()
})

// --- Tests ---------------------------------------------------------------

describe('StatusDot — hasRunningChildren outranks plan-ready', () => {
  it('returns statusWaitingChildren when plan-ready AND hasRunningChildren are both true', () => {
    // Core priority test. If the hasRunningChildren branch is moved below
    // plan-ready in StatusDot, this test goes RED.
    const color = renderDotColor({ ...BASE, waitingState: 'plan-ready', hasRunningChildren: true })
    expect(color).toBe(hex2rgb(C.statusWaitingChildren))
  })

  it('does NOT return statusComplete (plan-ready green) when hasRunningChildren is true', () => {
    // Explicit negative: green must not win while yellow is active.
    const color = renderDotColor({ ...BASE, waitingState: 'plan-ready', hasRunningChildren: true })
    expect(color).not.toBe(hex2rgb(C.statusComplete))
  })

  it('returns statusComplete for plan-ready with no running children (baseline)', () => {
    // Baseline: plan-ready alone → green, as expected.
    const color = renderDotColor({ ...BASE, waitingState: 'plan-ready', hasRunningChildren: false })
    expect(color).toBe(hex2rgb(C.statusComplete))
  })

  it('returns statusWaitingChildren for running children with no waiting state (baseline)', () => {
    // Baseline: children alone → yellow, as expected.
    const color = renderDotColor({ ...BASE, waitingState: null, hasRunningChildren: true })
    expect(color).toBe(hex2rgb(C.statusWaitingChildren))
  })

  it('foreground running still outranks running children', () => {
    // Orange wins over yellow — running/connecting is the highest active signal.
    const color = renderDotColor({ ...BASE, status: 'running', hasRunningChildren: true })
    expect(color).toBe(hex2rgb(C.statusRunning))
  })
})

describe('StatusDot — derived mode bypasses inline cascade', () => {
  it('renders the pre-computed color when derived prop is provided (yellow)', () => {
    // Derived mode: StatusDot must trust the pre-computed result from
    // getTabStatusColor and NOT re-run the inline cascade.
    const color = renderDotColor({
      derived: {
        bg: C.statusWaitingChildren,
        pulse: true,
        glow: true,
        glowColor: '#070707',
      },
    })
    expect(color).toBe(hex2rgb(C.statusWaitingChildren))
  })

  it('renders idle color when derived result is idle (no state active)', () => {
    const color = renderDotColor({
      derived: {
        bg: C.statusIdle,
        pulse: false,
        glow: false,
        glowColor: '#040404',
      },
    })
    expect(color).toBe(hex2rgb(C.statusIdle))
  })
})
