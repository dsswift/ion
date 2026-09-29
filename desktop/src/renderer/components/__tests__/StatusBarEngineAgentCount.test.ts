/**
 * HR-1 regression: `useActiveEngineAgentRunningCount` is TAB-TYPE-AGNOSTIC.
 *
 * The "waiting for N agent(s)" pulse must fire for a PLAIN
 * conversation that dispatched sub-agents, not just for extension-hosted
 * tabs — the Agent tool dispatches sub-agents regardless of harness, and the
 * close guard (tab-slice.ts) now blocks closing any tab with running children.
 * Pre-fix the selector returned 0 for `!tabHasExtensions(tab)`, so a plain tab
 * with running sub-agents showed no pulse.
 *
 * The selector reads `useSessionStore(selectorFn)`. We stub the store so the
 * call form invokes our selector against a fixed snapshot (pure fold, no
 * React, no DOM) — mirroring conversation-status-running-children.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const state: { tabs: any[]; activeTabId: string | null; conversationPanes: Map<string, any> } = {
  tabs: [],
  activeTabId: null,
  conversationPanes: new Map(),
}

// useActiveEngineAgentRunningCount calls `useSessionStore(selector)`, so the
// store mock must invoke the selector with the current state (the hook form),
// and also expose getState() for any sibling that uses it.
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))

vi.mock('zustand/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

// StatusBarEngineHelpers now imports effectiveRunningChildrenCount from
// conversation-status, which transitively imports @phosphor-icons/react and
// preferences.ts (both touch the DOM at module-load time in a browser
// environment). Mock them so this node-pure test doesn't fail with
// "document is not defined".
vi.mock('@phosphor-icons/react', () => ({
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1, gitOpsMode: 'standard' }) },
}))

import { useActiveEngineAgentRunningCount } from '../StatusBarEngineHelpers'

function reset() {
  state.tabs = []
  state.activeTabId = null
  state.conversationPanes = new Map()
}

function setActiveTab(tab: { id: string; engineProfileId: string | null }) {
  state.tabs = [tab]
  state.activeTabId = tab.id
}

function setPaneAgents(tabId: string, statuses: string[]) {
  state.conversationPanes.set(tabId, {
    instances: [{ id: 'main', label: 'main', statusFields: null, agentStates: statuses.map((status, i) => ({ name: `agent-${i}`, status })) }],
    activeInstanceId: 'main',
  })
}

function setPaneAgentsFull(tabId: string, agents: { name: string; id: string; status: string }[]) {
  state.conversationPanes.set(tabId, {
    instances: [{ id: 'main', label: 'main', statusFields: null, agentStates: agents }],
    activeInstanceId: 'main',
  })
}

/** Set only statusFields.backgroundAgents (agentStates stays empty — plain dispatch). */
function setPaneBackgroundAgents(tabId: string, count: number) {
  state.conversationPanes.set(tabId, {
    instances: [{ id: 'main', label: 'main', statusFields: { backgroundAgents: count }, agentStates: [] }],
    activeInstanceId: 'main',
  })
}

describe('useActiveEngineAgentRunningCount — tab-type-agnostic (HR-1)', () => {
  beforeEach(reset)

  it('counts running children on a PLAIN tab (engineProfileId: null)', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null })
    setPaneAgents('tab1', ['running', 'done', 'running'])
    expect(useActiveEngineAgentRunningCount()).toBe(2)
  })

  it('counts running children on an EXTENSION tab (parity)', () => {
    setActiveTab({ id: 'tab1', engineProfileId: 'test-profile' })
    setPaneAgents('tab1', ['running'])
    expect(useActiveEngineAgentRunningCount()).toBe(1)
  })

  it('returns 0 when a PLAIN tab has no running children', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null })
    setPaneAgents('tab1', ['done', 'idle', 'cancelled'])
    expect(useActiveEngineAgentRunningCount()).toBe(0)
  })

  it('returns 0 when there is no active instance', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null })
    expect(useActiveEngineAgentRunningCount()).toBe(0)
  })

  it('returns 0 when two same-name agents (distinct IDs) are both done', () => {
    // Regression: corrected engine snapshot gives each concurrent dispatch its
    // own slot keyed by dispatch ID. Two "engine-dev" dispatches that both
    // finished must yield running count 0, not a phantom stuck-running entry.
    setActiveTab({ id: 'tab1', engineProfileId: 'test-profile' })
    setPaneAgentsFull('tab1', [
      { name: 'engine-dev', id: 'dispatch-A', status: 'done' },
      { name: 'engine-dev', id: 'dispatch-B', status: 'done' },
    ])
    expect(useActiveEngineAgentRunningCount()).toBe(0)
  })

  it('returns backgroundAgents count when agentStates is empty (plain-conversation dispatch)', () => {
    // Regression for the solid-green-idle bug: a plain orchestrator conversation
    // idle with background agents. agentStates is empty; backgroundAgents carries
    // the live count. The old agentStates-only fold returned 0 here; this must
    // go RED if effectiveRunningChildrenCount is reverted.
    setActiveTab({ id: 'tab1', engineProfileId: null })
    setPaneBackgroundAgents('tab1', 3)
    expect(useActiveEngineAgentRunningCount()).toBe(3)
  })
})
