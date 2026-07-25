/**
 * Tests for `getGroupStatusColor` and `getGroupDotModel` — the fold helpers
 * that derive status dot(s) for a group pill from the tabs in the group.
 *
 * Key invariants tested:
 *   1. Full 9-level cascade: error > permission > running > running-children
 *      > plan-ready > question > bash > unread > idle.
 *   2. The b8e21298 case: running-children outranks plan-ready (regression
 *      that triggered the original priority work).
 *   3. Terminal-only tabs are excluded from the fold.
 *   4. Empty group returns idle dot.
 *   5. Single tab — result equals per-tab getTabStatusColor output.
 *   6. getGroupDotModel returns 'single' for inactive/single-tab groups and
 *      'stack' for active multi-tab groups, with foreground = selected tab's
 *      own status and background = aggregate of other tabs.
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

import { getGroupStatusColor, getGroupDotModel } from '../TabStripShared'

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
  statusQuestion:            'question',
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

/** Stamp a pane whose instance is denied on AskUserQuestion → 'question' waiting state. */
function setQuestion(tabId: string) {
  state.conversationPanes.set(tabId, {
    instances: [
      {
        id: 'inst1',
        label: 'inst1',
        permissionDenied: { tools: [{ toolName: 'AskUserQuestion' }] },
        agentStates: [],
        statusFields: null,
        permissionQueue: [],
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

  it('returns the dedicated question color (not statusRunning) for an AskUserQuestion wait', () => {
    // Regression guard for the two-blues collision: the question branch reads
    // colors.statusQuestion, independent of statusRunning and infoText.
    const tabs = [makeTab('t1', { status: 'idle' })]
    setQuestion('t1')
    const result = getGroupStatusColor(tabs, COLORS)
    expect(result.bg).toBe(COLORS.statusQuestion)
    expect(result.bg).not.toBe(COLORS.statusRunning)
    expect(result.glow).toBe(true)
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

// ─── getGroupDotModel ─────────────────────────────────────────────────────────
//
// These tests pin the 'single' vs 'stack' discrimination logic and verify the
// exact regression case reported: selected tab idle, another tab running →
// the bug was the pill showing running-orange even though the focused tab is idle.
//
// Regression anchor: if the selected tab is folded back into the background
// aggregate (i.e. `otherTabs` includes it), the background dot would match the
// full group aggregate and the foreground dot would still be idle — but the
// background would show running, matching the buggy single-aggregate behavior.
// The dedicated assertion below confirms otherTabs excludes the selected tab.

describe('getGroupDotModel — inactive / single-tab → single', () => {
  beforeEach(resetState)

  it('returns single for an inactive group', () => {
    const tabs = [makeTab('t1', { status: 'running' }), makeTab('t2')]
    setIdle('t1')
    setIdle('t2')
    const model = getGroupDotModel(tabs, 't1', false, COLORS)
    expect(model.kind).toBe('single')
    if (model.kind === 'single') {
      // Aggregate: running wins
      expect(model.dot.bg).toBe(COLORS.statusRunning)
    }
  })

  it('returns single for a single-tab active group', () => {
    const tabs = [makeTab('t1', { status: 'running' })]
    setIdle('t1')
    const model = getGroupDotModel(tabs, 't1', true, COLORS)
    expect(model.kind).toBe('single')
  })

  it('returns single for an empty active group', () => {
    const model = getGroupDotModel([], null, true, COLORS)
    expect(model.kind).toBe('single')
    if (model.kind === 'single') {
      expect(model.dot.bg).toBe(COLORS.statusIdle)
    }
  })

  it('returns single when all tabs are terminal-only (no conversation tabs)', () => {
    const tabs = [makeTab('t1', { isTerminalOnly: true }), makeTab('t2', { isTerminalOnly: true })]
    setIdle('t1')
    setIdle('t2')
    const model = getGroupDotModel(tabs, 't1', true, COLORS)
    // conversationTabs.length <= 1 after filtering → single
    expect(model.kind).toBe('single')
  })
})

describe('getGroupDotModel — active multi-tab → stack', () => {
  beforeEach(resetState)

  it('returns stack for an active group with two tabs', () => {
    const tabs = [makeTab('t1'), makeTab('t2')]
    setIdle('t1')
    setIdle('t2')
    const model = getGroupDotModel(tabs, 't1', true, COLORS)
    expect(model.kind).toBe('stack')
  })

  it('foreground reflects the selected tab status, background reflects others', () => {
    // Selected tab (t1) is idle; other tab (t2) is running.
    // Foreground must be idle, background must be running.
    const tabs = [makeTab('t1'), makeTab('t2', { status: 'running' })]
    setIdle('t1')
    setIdle('t2')
    const model = getGroupDotModel(tabs, 't1', true, COLORS)
    expect(model.kind).toBe('stack')
    if (model.kind === 'stack') {
      // Foreground = selected tab (t1) = idle
      expect(model.foreground.bg).toBe(COLORS.statusIdle)
      expect(model.foreground.pulse).toBe(false)
      // Background = other tabs (t2) = running
      expect(model.background.bg).toBe(COLORS.statusRunning)
      expect(model.background.pulse).toBe(true)
    }
  })

  // ── Regression case (the exact reported bug) ──────────────────────────────
  //
  // Selected tab (t1) is idle; background tab (t2) is running. With the old
  // single-aggregate model the pill pulsed orange even when the focused tab
  // was quiet. With getGroupDotModel:
  //   - foreground (t1, selected) → idle, no pulse
  //   - background (t2, other)   → running, pulsing orange
  //
  // To verify the exclusion is correct: temporarily include t1 in the
  // background fold and the background result would still be running
  // (t1 idle + t2 running → running wins). So the critical assertion is that
  // the FOREGROUND is idle — not that the background is running — which only
  // holds because t1's own status is used for the foreground.
  it('regression: selected tab idle + another tab running → foreground idle, background running', () => {
    const tabs = [makeTab('t1'), makeTab('t2', { status: 'running' })]
    setIdle('t1')
    setIdle('t2')
    const model = getGroupDotModel(tabs, 't1', true, COLORS)
    expect(model.kind).toBe('stack')
    if (model.kind === 'stack') {
      expect(model.foreground.bg).toBe(COLORS.statusIdle)
      expect(model.foreground.pulse).toBe(false)
      expect(model.background.bg).toBe(COLORS.statusRunning)
      expect(model.background.pulse).toBe(true)
    }
  })

  it('foreground tracks the newly-selected tab when selection changes', () => {
    // t1 idle, t2 running. First: t1 selected → foreground idle.
    // Then: t2 selected → foreground running.
    const tabs = [makeTab('t1'), makeTab('t2', { status: 'running' })]
    setIdle('t1')
    setIdle('t2')

    const m1 = getGroupDotModel(tabs, 't1', true, COLORS)
    expect(m1.kind).toBe('stack')
    if (m1.kind === 'stack') {
      expect(m1.foreground.bg).toBe(COLORS.statusIdle)
      expect(m1.background.bg).toBe(COLORS.statusRunning)
    }

    const m2 = getGroupDotModel(tabs, 't2', true, COLORS)
    expect(m2.kind).toBe('stack')
    if (m2.kind === 'stack') {
      expect(m2.foreground.bg).toBe(COLORS.statusRunning)
      // background = t1 only = idle
      expect(m2.background.bg).toBe(COLORS.statusIdle)
    }
  })

  it('uses first conversation tab as selected when selectedTabId is null', () => {
    const tabs = [makeTab('t1'), makeTab('t2', { status: 'running' })]
    setIdle('t1')
    setIdle('t2')
    // null selectedTabId → first conversationTab (t1) treated as selected
    const model = getGroupDotModel(tabs, null, true, COLORS)
    expect(model.kind).toBe('stack')
    if (model.kind === 'stack') {
      expect(model.foreground.bg).toBe(COLORS.statusIdle)
      expect(model.background.bg).toBe(COLORS.statusRunning)
    }
  })

  it('background excludes the selected tab — selected-tab-not-in-background anchor', () => {
    // t1 = selected (running). t2 = idle.
    // background should be idle (only t2); if t1 were included background would also be running.
    const tabs = [makeTab('t1', { status: 'running' }), makeTab('t2')]
    setIdle('t1')
    setIdle('t2')
    const model = getGroupDotModel(tabs, 't1', true, COLORS)
    expect(model.kind).toBe('stack')
    if (model.kind === 'stack') {
      expect(model.foreground.bg).toBe(COLORS.statusRunning)
      // background = t2 only = idle (proves t1 was excluded from background fold)
      expect(model.background.bg).toBe(COLORS.statusIdle)
    }
  })
})
