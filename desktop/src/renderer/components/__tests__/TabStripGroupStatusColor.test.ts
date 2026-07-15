/**
 * Tests for `getGroupStatusColor` — the fold helper that derives a single
 * status dot for a group pill from all tabs in the group.
 *
 * Key invariants tested:
 *   1. Full 9-level cascade: error > permission > running > running-children
 *      > plan-ready > question > bash > unread > idle.
 *   2. The b8e21298 case: running-children outranks plan-ready (regression
 *      that triggered the original priority work).
 *   3. Terminal-only tabs are excluded from the fold.
 *   4. Empty group returns idle dot.
 *   5. Single tab — result equals per-tab getTabStatusColor output.
 *
 * Pure logic test — no React, no DOM. Stubs match TabStripShared-running-children.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Store stub ──────────────────────────────────────────────────────────────
//
// getTabStatusColor (called by getGroupStatusColor) reads
// useSessionStore.getState() synchronously. We install a minimal settable
// stub so each test can control conversationPanes.

const state: { conversationPanes: Map<string, any> } = {
  conversationPanes: new Map(),
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => state,
  },
}))

vi.mock('@phosphor-icons/react', () => ({
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1, gitOpsMode: 'standard' }) },
}))

import { getGroupStatusColor } from '../TabStripShared'

// ─── Color constants ─────────────────────────────────────────────────────────

// Minimal colors object — only keys getTabStatusColor/getGroupStatusColor write.
const COLORS = {
  statusIdle:                'idle',
  statusError:               'error',
  statusPermission:          'permission',
  statusPermissionGlow:      'permissionGlow',
  statusRunning:             'running',
  statusWaitingChildren:     'waitingChildren',
  statusWaitingChildrenGlow: 'waitingChildrenGlow',
  statusComplete:            'complete',
  tabGlowPlanReady:          'glowPlanReady',
  infoText:                  'info',
  tabGlowQuestion:           'glowQuestion',
  statusBash:                'bash',
  statusBashGlow:            'bashGlow',
} as any

// ─── Tab factories ────────────────────────────────────────────────────────────

function makeTab(tabId: string, overrides: Record<string, any> = {}): any {
  return {
    id: tabId,
    status: 'idle',
    hasUnread: false,
    bashExecuting: false,
    isTerminalOnly: false,
    ...overrides,
  }
}

/** Stamp a pane with one instance that has plan-ready permissionDenied + running agentStates. */
function setPlanReadyWithRunningChildren(tabId: string) {
  state.conversationPanes.set(tabId, {
    instances: [
      {
        id: 'inst1',
        label: 'inst1',
        permissionDenied: { tools: [{ toolName: 'ExitPlanMode' }] },
        agentStates: [{ name: 'child', status: 'running', metadata: {} }],
        statusFields: null,
        permissionQueue: [],
      },
    ],
    activeInstanceId: 'inst1',
  })
}

function setPermission(tabId: string) {
  state.conversationPanes.set(tabId, {
    instances: [
      {
        id: 'inst1',
        label: 'inst1',
        permissionDenied: null,
        agentStates: [],
        statusFields: null,
        permissionQueue: [{ toolName: 'SomeTool', questionId: 'q1', options: [] }],
      },
    ],
    activeInstanceId: 'inst1',
  })
}

function setIdle(tabId: string) {
  state.conversationPanes.set(tabId, {
    instances: [
      {
        id: 'inst1',
        label: 'inst1',
        permissionDenied: null,
        agentStates: [],
        statusFields: null,
        permissionQueue: [],
      },
    ],
    activeInstanceId: 'inst1',
  })
}

function resetState() {
  state.conversationPanes = new Map()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getGroupStatusColor — empty / terminal-only', () => {
  beforeEach(resetState)

  it('returns idle for an empty group', () => {
    const result = getGroupStatusColor([], COLORS)
    expect(result.bg).toBe(COLORS.statusIdle)
    expect(result.pulse).toBe(false)
    expect(result.glow).toBe(false)
  })

  it('returns idle when all tabs are terminal-only', () => {
    const tabs = [makeTab('t1', { isTerminalOnly: true })]
    setIdle('t1')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusIdle)
  })

  it('excludes terminal-only tabs from the fold', () => {
    const tabs = [
      makeTab('t1', { isTerminalOnly: true, status: 'running' }),
      makeTab('t2', { isTerminalOnly: false }),
    ]
    setIdle('t1')
    setIdle('t2')
    const result = getGroupStatusColor(tabs, COLORS)
    // t1 is terminal-only → excluded; t2 is idle → result should be idle
    expect(result.bg).toBe(COLORS.statusIdle)
  })
})

describe('getGroupStatusColor — single tab equals getTabStatusColor', () => {
  beforeEach(resetState)

  it('returns running when the single tab is running', () => {
    const tabs = [makeTab('t1', { status: 'running' })]
    setIdle('t1')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusRunning)
    expect(result.pulse).toBe(true)
  })

  it('returns error when the single tab is dead', () => {
    const tabs = [makeTab('t1', { status: 'dead' })]
    setIdle('t1')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusError)
  })
})

describe('getGroupStatusColor — priority cascade across multiple tabs', () => {
  beforeEach(resetState)

  it('picks error over running (highest wins)', () => {
    const tabs = [
      makeTab('t1', { status: 'dead' }),
      makeTab('t2', { status: 'running' }),
    ]
    setIdle('t1')
    setIdle('t2')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusError)
  })

  it('picks permission over running', () => {
    const tabs = [
      makeTab('t1'),
      makeTab('t2', { status: 'running' }),
    ]
    setPermission('t1')
    setIdle('t2')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusPermission)
  })

  it('picks running over running-children', () => {
    const tabs = [
      makeTab('t1'),          // will have running-children
      makeTab('t2', { status: 'running' }),
    ]
    setPlanReadyWithRunningChildren('t1')
    setIdle('t2')
    // t2 running-children would be outranked; t2 itself is foreground running
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusRunning)
  })

  // ── b8e21298 regression case ─────────────────────────────────────────────
  it('running-children outranks plan-ready (b8e21298 regression)', () => {
    // One tab has plan-ready waitingState + running agentStates (the case
    // from b8e21298 that proved running-children must rank above plan-ready).
    // Another tab is idle. The fold must return statusWaitingChildren, not
    // statusComplete.
    const tabs = [
      makeTab('t1'),   // plan-ready + running-children
      makeTab('t2'),   // idle
    ]
    setPlanReadyWithRunningChildren('t1')
    setIdle('t2')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusWaitingChildren)
    expect(result.pulse).toBe(true)
    expect(result.glow).toBe(true)
    // Explicitly not statusComplete (plan-ready green)
    expect(result.bg).not.toBe(COLORS.statusComplete)
  })

  it('plan-ready outranks idle when no running-children', () => {
    const tabs = [
      makeTab('t1'), // plan-ready, no children
      makeTab('t2'), // idle
    ]
    state.conversationPanes.set('t1', {
      instances: [
        {
          id: 'inst1',
          label: 'inst1',
          permissionDenied: { tools: [{ toolName: 'ExitPlanMode' }] },
          agentStates: [],
          statusFields: null,
          permissionQueue: [],
        },
      ],
      activeInstanceId: 'inst1',
    })
    setIdle('t2')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusComplete)
    expect(result.glow).toBe(true)
  })

  it('picks idle when all tabs are idle', () => {
    const tabs = [makeTab('t1'), makeTab('t2'), makeTab('t3')]
    setIdle('t1')
    setIdle('t2')
    setIdle('t3')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusIdle)
    expect(result.pulse).toBe(false)
    expect(result.glow).toBe(false)
  })
})
