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

import { anyEngineInstanceHasRunningChildren, isAnyEngineInstanceRunning } from '../TabStripShared'

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
