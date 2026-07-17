/**
 * Tests for `anyEngineInstanceHasRunningChildren` — the per-engine-tab
 * fold helper that drives:
 *
 *   - the yellow "awaiting children" pulse on the parent tab pill
 *     (via `getTabStatusColor` in TabStripShared.ts and the
 *     `hasRunningChildren` prop on TabStripStatusDot.tsx)
 *   - the hard-block of the X close button (via `closeBlocked`
 *     in TabStripTabPill.tsx)
 *   - the action-layer guard in `tab-slice.ts` closeTab
 *
 * Sibling to `isAnyEngineInstanceRunning`. Pure logic — no React,
 * no DOM. Tests the fold semantics directly by stubbing
 * `useSessionStore.getState()` and verifying each branch:
 *
 *   1. No enginePane → false (CLI tab or unknown tab id)
 *   2. Pane with empty instances → false
 *   3. Pane with instances but no engineAgentStates entry → false
 *   4. Pane with instances + agents all idle/done → false
 *   5. Pane with one instance whose agents include a running one → true
 *   6. Pane with multiple instances, only one carries a running agent
 *      → true (the fold short-circuits on the first match)
 *
 * The helper does not subscribe to state — callers must subscribe in
 * React. Tests don't validate reactivity; they validate the fold
 * arithmetic against a fixed snapshot. The reactive wiring is
 * exercised end-to-end by TabStripTabPill's `useSessionStore` calls
 * documented at lines 60-72 of that file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub the store module before importing the helper. The helper reads
// `useSessionStore.getState()` synchronously, so we just need a
// settable mock to swap the world per test.
const state: { conversationPanes: Map<string, any> } = {
  conversationPanes: new Map(),
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => state,
  },
}))

// Avoid pulling in the @phosphor-icons React graph (TabStripShared
// re-exports PILL_ICON_PRESETS which references icons). The mock keeps
// the helper test fast and node-pure.
vi.mock('@phosphor-icons/react', () => ({
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1, gitOpsMode: 'standard' }) },
}))

import { anyEngineInstanceHasRunningChildren, effectiveRunningChildrenCount, isAnyEngineInstanceRunning, getTabStatusColor } from '../TabStripShared'

function resetState() {
  state.conversationPanes = new Map()
}

function setPane(tabId: string, instanceIds: string[]) {
  state.conversationPanes.set(tabId, {
    instances: instanceIds.map((id) => ({ id, label: id, agentStates: [], statusFields: null })),
    activeInstanceId: instanceIds[0] || null,
  })
}

function setAgents(tabId: string, instanceId: string, statuses: string[]) {
  const pane = state.conversationPanes.get(tabId)
  if (!pane) return
  const idx = pane.instances.findIndex((i: any) => i.id === instanceId)
  if (idx === -1) return
  pane.instances[idx] = {
    ...pane.instances[idx],
    agentStates: statuses.map((status, i) => ({ name: `agent-${i}`, status, metadata: {} })),
  }
}

/** Stamp inst.statusFields.backgroundAgents on the first instance of tabId. */
function setBackgroundAgents(tabId: string, instanceId: string, count: number) {
  const pane = state.conversationPanes.get(tabId)
  if (!pane) return
  const idx = pane.instances.findIndex((i: any) => i.id === instanceId)
  if (idx === -1) return
  const existing = pane.instances[idx].statusFields || {}
  pane.instances[idx] = {
    ...pane.instances[idx],
    statusFields: { ...existing, backgroundAgents: count },
  }
}

describe('anyEngineInstanceHasRunningChildren', () => {
  beforeEach(resetState)

  it('returns false when the tab has no enginePane entry', () => {
    expect(anyEngineInstanceHasRunningChildren('unknown')).toBe(false)
  })

  it('returns false when the pane has zero instances', () => {
    setPane('tab1', [])
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(false)
  })

  it('returns false when no engineAgentStates entry exists for the instance', () => {
    setPane('tab1', ['inst1'])
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(false)
  })

  it('returns false when every agent is in a terminal status', () => {
    setPane('tab1', ['inst1'])
    setAgents('tab1', 'inst1', ['done', 'error', 'cancelled', 'idle'])
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(false)
  })

  it('returns true when any agent on the only instance is running', () => {
    setPane('tab1', ['inst1'])
    setAgents('tab1', 'inst1', ['done', 'running'])
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(true)
  })

  it('returns true when a sibling instance has a running agent even if the active one is idle', () => {
    setPane('tab1', ['inst1', 'inst2'])
    setAgents('tab1', 'inst1', ['done'])
    setAgents('tab1', 'inst2', ['running'])
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(true)
  })

  it('does not bleed across tabs', () => {
    setPane('tab1', ['inst1'])
    setPane('tab2', ['inst1'])
    setAgents('tab2', 'inst1', ['running'])
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(false)
    expect(anyEngineInstanceHasRunningChildren('tab2')).toBe(true)
  })

  it('is independent of orchestrator state (yellow vs. orange)', () => {
    setPane('tab1', ['inst1'])
    setAgents('tab1', 'inst1', ['running'])
    // Set statusFields on the instance directly (no legacy Map)
    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = { ...pane.instances[0], statusFields: { state: 'running' } }
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(true)
    expect(isAnyEngineInstanceRunning('tab1')).toBe(true)
  })
})

// ─── effectiveRunningChildrenCount unit tests ─────────────────────────────────
//
// These test the canonical helper directly. Each case must go RED if the helper
// is reverted to an agentStates-only fold.

describe('effectiveRunningChildrenCount', () => {
  it('returns 0 when agentStates is empty and backgroundAgents is absent', () => {
    expect(effectiveRunningChildrenCount({ agentStates: [], statusFields: null })).toBe(0)
  })

  it('counts running entries from agentStates only', () => {
    const inst = {
      agentStates: [{ status: 'running' }, { status: 'done' }, { status: 'running' }],
      statusFields: null,
    }
    expect(effectiveRunningChildrenCount(inst)).toBe(2)
  })

  it('returns backgroundAgents when agentStates is empty (plain-conversation dispatch)', () => {
    // This is the bug scenario: a plain orchestrator conversation idle with
    // background agents running. agentStates is empty; backgroundAgents carries
    // the count. Reverting the helper to agentStates-only makes this go RED.
    const inst = {
      agentStates: [],
      statusFields: { backgroundAgents: 3 },
    }
    expect(effectiveRunningChildrenCount(inst)).toBe(3)
  })

  it('returns max (not sum) when both sources are non-zero', () => {
    // 1 running agentState + backgroundAgents=2 → max(1,2) = 2, not 3.
    // Both vantage points observe the same agents; summing would double-count.
    const inst = {
      agentStates: [{ status: 'running' }],
      statusFields: { backgroundAgents: 2 },
    }
    expect(effectiveRunningChildrenCount(inst)).toBe(2)
  })

  it('returns 0 when backgroundAgents is 0 and no running agentStates', () => {
    const inst = {
      agentStates: [{ status: 'done' }],
      statusFields: { backgroundAgents: 0 },
    }
    expect(effectiveRunningChildrenCount(inst)).toBe(0)
  })

  it('ignores backgroundAgents when undefined (treats as 0)', () => {
    // statusFields present but backgroundAgents absent → only agentStates counted
    const inst = {
      agentStates: [{ status: 'running' }],
      statusFields: { backgroundAgents: undefined },
    }
    expect(effectiveRunningChildrenCount(inst)).toBe(1)
  })
})

// ─── anyEngineInstanceHasRunningChildren — backgroundAgents branch ─────────────
//
// These verify the fix end-to-end through the store-fold entry point.
// Each must go RED if anyEngineInstanceHasRunningChildren is reverted to
// iterate only inst.agentStates.

describe('anyEngineInstanceHasRunningChildren — backgroundAgents branch', () => {
  beforeEach(resetState)

  it('returns true when agentStates is empty but statusFields.backgroundAgents > 0', () => {
    // Core regression case: plain orchestrator conversation idle with background
    // agents still running. agentStates is empty (engine does not populate it
    // for plain dispatches); backgroundAgents carries the live count.
    setPane('tab1', ['inst1'])
    setBackgroundAgents('tab1', 'inst1', 2)
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(true)
  })

  it('resolves via max when both agentStates and backgroundAgents are non-zero', () => {
    // Proves we take max(1, 2) = 2, and the result is > 0 (true), not a sum.
    // If this returned false the max logic is broken.
    setPane('tab1', ['inst1'])
    setAgents('tab1', 'inst1', ['running'])   // fromAgentStates = 1
    setBackgroundAgents('tab1', 'inst1', 2)   // fromBackgroundAgents = 2
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(true)
    // Verify the count via effectiveRunningChildrenCount directly:
    const pane = state.conversationPanes.get('tab1')
    const inst = pane.instances[0]
    expect(effectiveRunningChildrenCount(inst)).toBe(2)  // max, not sum (3)
  })

  it('returns false when backgroundAgents is 0 and agentStates is empty', () => {
    setPane('tab1', ['inst1'])
    setBackgroundAgents('tab1', 'inst1', 0)
    expect(anyEngineInstanceHasRunningChildren('tab1')).toBe(false)
  })
})

// ─── getTabStatusColor — priority cascade ─────────────────────────────────────
//
// Verifies that anyEngineInstanceHasRunningChildren (yellow) outranks plan-ready
// (green) in the getTabStatusColor priority cascade.
//
// The key invariant: when a tab has plan-ready waitingState AND running children,
// the result must be statusWaitingChildren (yellow), not statusComplete (green).
//
// These tests MUST go RED if the reorder in getTabStatusColor is undone
// (i.e. if plan-ready is moved back above anyEngineInstanceHasRunningChildren).

// Minimal colors stub — only the keys getTabStatusColor writes to.
const COLORS = {
  statusIdle: 'idle',
  statusError: 'error',
  statusPermission: 'permission',
  statusPermissionGlow: 'permissionGlow',
  statusRunning: 'running',
  statusWaitingChildren: 'waitingChildren',
  statusWaitingChildrenGlow: 'waitingChildrenGlow',
  statusComplete: 'complete',
  tabGlowPlanReady: 'glowPlanReady',
  infoText: 'info',
  tabGlowQuestion: 'glowQuestion',
  statusBash: 'bash',
  statusBashGlow: 'bashGlow',
} as any

/** Build a minimal TabState that getTabStatusColor accepts. */
function makeTab(tabId: string, overrides: Record<string, any> = {}): any {
  return {
    id: tabId,
    status: 'idle',
    hasUnread: false,
    bashExecuting: false,
    ...overrides,
  }
}

/** Stamp a pane with one instance that has plan-ready permissionDenied + running agentStates. */
function setPlanReadyWithRunningChildren(tabId: string, instanceId = 'inst1') {
  state.conversationPanes.set(tabId, {
    instances: [
      {
        id: instanceId,
        label: instanceId,
        // permissionDenied with ExitPlanMode triggers plan-ready waitingState
        permissionDenied: { tools: [{ toolName: 'ExitPlanMode' }] },
        // running agentStates triggers anyEngineInstanceHasRunningChildren
        agentStates: [{ name: 'child', status: 'running', metadata: {} }],
        statusFields: null,
        // permissionQueue must be present and empty so the permission branch is skipped
        permissionQueue: [],
      },
    ],
    activeInstanceId: instanceId,
  })
}

describe('getTabStatusColor — children outrank plan-ready', () => {
  beforeEach(resetState)

  it('returns statusWaitingChildren when plan-ready AND running children coexist', () => {
    // This is the core priority test. If anyEngineInstanceHasRunningChildren is
    // moved below plan-ready in the cascade, this test goes RED.
    setPlanReadyWithRunningChildren('tab1')
    const tab = makeTab('tab1')
    const result = getTabStatusColor(tab, COLORS)
    expect(result.bg).toBe(COLORS.statusWaitingChildren)
    expect(result.pulse).toBe(true)
    expect(result.glow).toBe(true)
  })

  it('does NOT return statusComplete (plan-ready green) when children are running', () => {
    // Explicit negative: green must not win when yellow is active.
    setPlanReadyWithRunningChildren('tab1')
    const tab = makeTab('tab1')
    const result = getTabStatusColor(tab, COLORS)
    expect(result.bg).not.toBe(COLORS.statusComplete)
  })

  it('returns statusComplete for plan-ready with no running children (baseline)', () => {
    // Baseline: plan-ready with no children → green, as expected.
    state.conversationPanes.set('tab2', {
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
    const tab = makeTab('tab2')
    const result = getTabStatusColor(tab, COLORS)
    expect(result.bg).toBe(COLORS.statusComplete)
  })
})
