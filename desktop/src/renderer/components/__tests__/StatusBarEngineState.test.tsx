// @vitest-environment jsdom
/**
 * Regression: the engine-state status-bar slot ("[running]" /
 * "[waiting for N agent(s)]") must render from the signals that are
 * actually populated in the renderer — `tab.status` for the orchestrator's own
 * run-state and `useActiveEngineAgentRunningCount()` for the dispatched
 * agent count — NOT from `inst.statusFields`, which the renderer
 * never populates.
 *
 * Pre-fix, `StatusBarEngineState` did `const status = useActiveEngineStatusFields()`
 * then `if (!status) return null`. Because `inst.statusFields` is always null in
 * the renderer, the slot rendered nothing on EVERY tab — the yellow
 * "waiting for N agent(s)" text never appeared. The idle+running-agent
 * case below is the regression assertion: it is red on the pre-fix code (slot
 * returns null) and green after the fix.
 *
 * The store is stubbed so the component's narrow `useSessionStore(useShallow(...))`
 * selector folds a fixed snapshot, and `useActiveEngineAgentRunningCount` (which
 * also calls `useSessionStore(selector)`) reads the same snapshot. `useColors`
 * and `zustand/shallow` are stubbed so the test is a pure render with no theme
 * or store wiring. Renders via react-dom/client + act into jsdom (matching
 * ToolGroup.test.tsx), asserting on rendered text.
 */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state: { tabs: any[]; activeTabId: string | null; conversationPanes: Map<string, any> } = {
  tabs: [],
  activeTabId: null,
  conversationPanes: new Map(),
}

// Both the component's `tab.status` selector and `useActiveEngineAgentRunningCount`
// call `useSessionStore(selector)`, so the mock invokes the selector with the
// fixed snapshot (the hook form) and also exposes getState().
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))

// useShallow is identity here — the selector is invoked directly against state.
vi.mock('zustand/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

// useColors yields a distinct color per token so we can assert which branch
// (running vs. waiting-children) drove the dot color.
vi.mock('../../theme', () => ({
  useColors: () => ({
    statusRunning: '#d97757',
    statusWaitingChildren: '#f59e0b',
    statusBash: '#ff2d95',
    textTertiary: '#888888',
  }),
}))

import { StatusBarEngineState } from '../StatusBarEngineState'

function reset() {
  state.tabs = []
  state.activeTabId = null
  state.conversationPanes = new Map()
}

function setActiveTab(tab: { id: string; engineProfileId: string | null; status: string }) {
  state.tabs = [tab]
  state.activeTabId = tab.id
}

function setPaneAgents(tabId: string, statuses: string[], backgroundShells = 0, hasPendingWork?: boolean) {
  state.conversationPanes.set(tabId, {
    instances: [
      {
        id: 'main',
        label: 'main',
        // backgroundShells is the ONE statusFields value the renderer does
        // populate (the engine stamps it on every status snapshot), so the
        // shell branch reads a real field where the agent branch reads
        // agentStates. null when no shells and hasPendingWork is unset,
        // matching a fresh instance.
        statusFields: backgroundShells > 0 || hasPendingWork !== undefined
          ? { backgroundShells, hasPendingWork }
          : null,
        agentStates: statuses.map((status, i) => ({ name: `agent-${i}`, status })),
      },
    ],
    activeInstanceId: 'main',
  })
}

function renderHTML(): string {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => {
      root.render(<StatusBarEngineState />)
    })
    return container.innerHTML
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

describe('StatusBarEngineState — derives from tab.status + agentRunningCount', () => {
  beforeEach(reset)

  it('PLAIN tab, idle orchestrator, 1 running agent → "[waiting for 1 agent]" (REGRESSION)', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'idle' })
    setPaneAgents('tab1', ['running', 'done'])
    expect(renderHTML()).toContain('[waiting for 1 agent]')
  })

  it('PLAIN tab, idle orchestrator, 2 running agents → pluralized "agents"', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'idle' })
    setPaneAgents('tab1', ['running', 'running'])
    expect(renderHTML()).toContain('[waiting for 2 agents]')
  })

  it('EXTENSION tab, idle orchestrator, 1 running agent → renders waiting text (parity)', () => {
    setActiveTab({ id: 'tab1', engineProfileId: 'test-profile', status: 'idle' })
    setPaneAgents('tab1', ['running'])
    expect(renderHTML()).toContain('[waiting for 1 agent]')
  })

  it('running orchestrator + running agents → "[running]", no waiting text (priority cascade)', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'running' })
    setPaneAgents('tab1', ['running'])
    const html = renderHTML()
    expect(html).toContain('[running]')
    expect(html).not.toContain('waiting for')
  })

  it('connecting orchestrator → "[running]" (connecting treated as foreground)', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'connecting' })
    setPaneAgents('tab1', [])
    expect(renderHTML()).toContain('[running]')
  })

  it('idle orchestrator, 0 running agents → renders nothing', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'idle' })
    setPaneAgents('tab1', ['done', 'cancelled'])
    expect(renderHTML()).toBe('')
  })
})

// ─── Background-shell branch ──────────────────────────────────────────────────

// The shell counterpart to the agent cases above. useActiveEngineBackgroundShellCount
// and the three-way stateColor/label cascade shipped with no test at all, so
// none of these boundaries were pinned: the branch firing, its singular/plural
// wording, or its rank against agents.
describe('StatusBarEngineState — background-shell branch', () => {
  beforeEach(reset)

  it('idle orchestrator, 1 background shell → "[waiting for 1 background shell]"', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'idle' })
    setPaneAgents('tab1', [], 1)
    expect(renderHTML()).toContain('[waiting for 1 background shell]')
  })

  it('pluralizes at 2 → "background shells"', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'idle' })
    setPaneAgents('tab1', [], 2)
    expect(renderHTML()).toContain('[waiting for 2 background shells]')
  })

  it('agents outrank shells when both are outstanding', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'idle' })
    setPaneAgents('tab1', ['running'], 3)
    const html = renderHTML()
    expect(html).toContain('[waiting for 1 agent]')
    expect(html).not.toContain('background shell')
  })

  it('a running orchestrator outranks shells', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'running' })
    setPaneAgents('tab1', [], 2)
    const html = renderHTML()
    expect(html).toContain('[running]')
    expect(html).not.toContain('background shell')
  })

  it('renders nothing when idle with no agents and no shells', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'idle' })
    setPaneAgents('tab1', [], 0)
    expect(renderHTML()).toBe('')
  })

  it('uses the statusBash token for the shell dot, not the agent token', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'idle' })
    setPaneAgents('tab1', [], 1)
    // jsdom serializes inline styles as rgb(), not the source hex.
    const html = renderHTML()
    expect(html).toContain('rgb(255, 45, 149)')      // statusBash
    expect(html).not.toContain('rgb(245, 158, 11)')  // statusWaitingChildren
  })

  // REGRESSION (PLAIN tab — the actual path a real background Bash task
  // takes): the main process derives `tab.status === 'waiting'` whenever the
  // engine reports hasPendingWork/backgroundAgents/backgroundShells on an
  // idle engine_status (engine-control-plane-status-event.ts `setStatus(tabId,
  // 'waiting')`). The pre-fix component OR'd `status === 'waiting'` straight
  // into `isWaitingChildren`, so a plain tab with one outstanding shell and
  // zero running agents rendered the vague "waiting for queued work" instead
  // of the specific shell count — even though `shellRunningCount` (the
  // richer, correct signal) was available the whole time. This is the exact
  // state a live `Bash({ run_in_background: true, notify_on_complete: true })`
  // call produces.
  it('PLAIN tab, status "waiting", 1 background shell, 0 agents → shell-specific label, not "waiting for queued work" (REGRESSION)', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'waiting' })
    setPaneAgents('tab1', [], 1)
    const html = renderHTML()
    expect(html).toContain('[waiting for 1 background shell]')
    expect(html).not.toContain('waiting for queued work')
  })

  // A plain tab's status is 'waiting' with NO shells and NO agents when the
  // engine's hasPendingWork fired for some other reason (a queued prompt, a
  // dispatch completion, a parked run) — the one case with no more specific
  // signal available. The generic fallback is correct here and must still
  // fire so the slot doesn't go silent.
  it('PLAIN tab, status "waiting", 0 shells, 0 agents → falls back to "waiting for queued work"', () => {
    setActiveTab({ id: 'tab1', engineProfileId: null, status: 'waiting' })
    setPaneAgents('tab1', [], 0)
    expect(renderHTML()).toContain('[waiting for queued work]')
  })

  // EXTENSION-tab parity: the same conflation existed on the statusFields
  // path (`useActiveEngineStatusFields()`, populated only for extension
  // tabs — see tabHasExtensions gating). A background shell there must win
  // over the generic hasPendingWork flag exactly like the plain-tab path.
  it('EXTENSION tab, statusFields.hasPendingWork true, 1 background shell, 0 agents → shell-specific label (parity)', () => {
    setActiveTab({ id: 'tab1', engineProfileId: 'test-profile', status: 'idle' })
    setPaneAgents('tab1', [], 1, true)
    const html = renderHTML()
    expect(html).toContain('[waiting for 1 background shell]')
    expect(html).not.toContain('waiting for queued work')
  })

  it('EXTENSION tab, statusFields.hasPendingWork true, 0 shells, 0 agents → falls back to "waiting for queued work"', () => {
    setActiveTab({ id: 'tab1', engineProfileId: 'test-profile', status: 'idle' })
    setPaneAgents('tab1', [], 0, true)
    expect(renderHTML()).toContain('[waiting for queued work]')
  })
})
