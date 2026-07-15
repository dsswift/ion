// @vitest-environment jsdom
//
// Scoping + drill-down tests for AgentPanel:
//  - rootOnly: the main conversation panel hides agents that are nested
//    dispatches (their own metadata carries dispatchDepth>=2 / a parent id),
//    and keeps roots + agents with no attribution (untracked / roster rows).
//  - subDispatch: the popup-embedded tier bypasses the top-level-only
//    visibility filter, so a completed (done) child with no `visibility`
//    metadata still renders (the empty-popup-panel regression).
//  - alwaysRender: the popup-embedded panel renders its "Agents (0)" header
//    even with zero agents (the missing-preview-panel defect).
//  - onOpenDispatch: clicking a row escalates to the callback (drill-down via
//    the parent popup's breadcrumb stack) instead of opening the internal popup.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../../preferences', () => ({
  // default-open so rows render; popup OFF so the inline path is the default and
  // onOpenDispatch (when provided) is unambiguously the escalation under test.
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ agentPanelDefaultOpen: true, agentDetailPopup: true, unifiedTurnView: false }),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      agentDetailGeometry: { x: 0, y: 0, w: 600, h: 500 },
      setAgentDetailGeometry: () => {},
      dispatchActivity: {},
    }),
}))

vi.mock('../FloatingPanel', () => ({
  FloatingPanel: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'floating-panel' }, children),
}))

vi.mock('../conversation', () => ({
  groupMessages: () => [],
  ToolGroup: () => null,
  AssistantMessage: () => null,
  MessageBubble: () => null,
  AgentTurnGroup: () => null,
  ThinkingBlock: () => null,
}))

import { AgentPanel } from '../AgentPanel'
import type { AgentStateUpdate } from '../../../shared/types'
import type { DispatchInfo } from '../agent-panel-helpers'

/** A sticky+invited running agent (passes the top-level visibility filter). */
function devLead(): AgentStateUpdate {
  return {
    name: 'dev-lead',
    id: 'd-root',
    status: 'running',
    metadata: {
      displayName: 'Dev Lead',
      type: 'agent',
      visibility: 'sticky',
      invited: true,
      task: 'do work',
      dispatches: [{ id: 'd-root', task: 'do work', model: 'claude', status: 'running', conversationId: 'conv-root', startTime: 1 }],
    },
  } as unknown as AgentStateUpdate
}

/** A telemetry-derived child stub: DONE, and carrying NO `visibility` metadata
 *  (exactly the shape AgentDetailPanel builds for child agents). Under the main
 *  panel's visibility filter this would be hidden (ephemeral default needs
 *  running); under subDispatch it must show. */
function engineDevChildStub(): AgentStateUpdate {
  return {
    name: 'engine-dev',
    status: 'done',
    metadata: {
      displayName: 'engine-dev',
      dispatches: [{ id: 'd-child', task: 'brief', model: 'claude', status: 'done', conversationId: 'conv-child', elapsed: 5 }],
    },
  } as unknown as AgentStateUpdate
}

function render(_el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root }
}

async function mount(container: HTMLDivElement, root: ReturnType<typeof createRoot>, el: React.ReactElement) {
  await act(async () => { root.render(el) })
  await act(async () => { await Promise.resolve() })
  // Expand the panel if it rendered collapsed.
  if (!container.textContent?.includes('Dev Lead') && !container.textContent?.includes('engine-dev')) {
    const header = Array.from(container.querySelectorAll('div')).find((el) =>
      el.textContent?.includes('Agents ('),
    ) as HTMLElement | undefined
    if (header) await act(async () => { header.click() })
  }
}

describe('AgentPanel scoping and drill-down', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = {
      getConversation: vi.fn(async () => ({ messages: [], total: 0 })),
    }
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('rootOnly hides nested-dispatch agents and keeps root agents', async () => {
    const { container, root } = render(<div />)
    // engine-dev is a depth-2 dispatch of dev-lead (its own metadata carries
    // dispatchDepth=2 + the parent id) -> hidden from the main panel. dev-lead
    // is a root (depth 1, no parent) -> shown. Both are running, so visibility
    // is not what hides engine-dev — the rootOnly per-instance filter is.
    const engineDevRunning = {
      ...engineDevChildStub(),
      status: 'running',
      metadata: {
        ...engineDevChildStub().metadata,
        visibility: 'sticky',
        invited: true,
        dispatchDepth: 2,
        dispatchParentId: 'd-root',
      },
    } as AgentStateUpdate
    await mount(container, root, <AgentPanel agents={[devLead(), engineDevRunning]} rootOnly />)

    expect(container.textContent).toContain('Dev Lead')
    expect(container.textContent).not.toContain('engine-dev')

    await act(async () => { root.unmount() })
    container.remove()
  })

  it('without rootOnly, a nested-dispatch agent is shown', async () => {
    const { container, root } = render(<div />)
    const engineDevRunning = {
      ...engineDevChildStub(),
      status: 'running',
      metadata: {
        ...engineDevChildStub().metadata,
        visibility: 'sticky',
        invited: true,
        dispatchDepth: 2,
        dispatchParentId: 'd-root',
      },
    } as AgentStateUpdate
    await mount(container, root, <AgentPanel agents={[devLead(), engineDevRunning]} />)
    expect(container.textContent).toContain('engine-dev')
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('rootOnly keeps a root-level dispatch even when another agent of the SAME name is nested (per-instance filter)', async () => {
    const { container, root } = render(<div />)
    // The superseded name-based heuristic kept BOTH instances of a name visible
    // when the name had any root dispatch. Per-instance attribution judges each
    // pill on its own depth/parent: the depth-2 'worker' is hidden, the depth-1
    // 'worker' stays.
    const rootWorker = {
      name: 'worker', id: 'w-root', status: 'running',
      metadata: {
        displayName: 'Worker Root', visibility: 'sticky', invited: true,
        dispatchDepth: 1, dispatchParentId: '',
        dispatches: [{ id: 'w-root', task: 't', model: 'claude', status: 'running', conversationId: 'cw1' }],
      },
    } as unknown as AgentStateUpdate
    const nestedWorker = {
      name: 'worker', id: 'w-child', status: 'running',
      metadata: {
        displayName: 'Worker Nested', visibility: 'sticky', invited: true,
        dispatchDepth: 2, dispatchParentId: 'd-root',
        dispatches: [{ id: 'w-child', task: 't', model: 'claude', status: 'running', conversationId: 'cw2' }],
      },
    } as unknown as AgentStateUpdate
    await mount(container, root, <AgentPanel agents={[rootWorker, nestedWorker]} rootOnly />)
    // Exactly the root instance's display name shows; the nested one does not.
    expect(container.textContent).toContain('Worker Root')
    expect(container.textContent).not.toContain('Worker Nested')
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('alwaysRender shows the "Agents (0)" header with zero agents (dispatch-preview panel)', async () => {
    const { container, root } = render(<div />)
    await act(async () => { root.render(<AgentPanel agents={[]} subDispatch alwaysRender />) })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('Agents (0)')
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('without alwaysRender, zero agents renders nothing (main panel self-hides)', async () => {
    const { container, root } = render(<div />)
    await act(async () => { root.render(<AgentPanel agents={[]} />) })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent ?? '').not.toContain('Agents (')
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('subDispatch bypasses the visibility filter: a done child with no visibility metadata still shows', async () => {
    const { container, root } = render(<div />)
    await mount(container, root, <AgentPanel agents={[engineDevChildStub()]} subDispatch />)
    // Under the main panel this would be hidden (ephemeral default needs
    // running); subDispatch makes it render.
    expect(container.textContent).toContain('engine-dev')
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('without subDispatch, a done child with no visibility metadata is hidden', async () => {
    const { container, root } = render(<div />)
    await mount(container, root, <AgentPanel agents={[engineDevChildStub()]} />)
    expect(container.textContent ?? '').not.toContain('engine-dev')
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('onOpenDispatch: clicking an agent row escalates to the callback and does not open the internal popup', async () => {
    const { container, root } = render(<div />)
    const onOpenDispatch = vi.fn<(d: DispatchInfo, a: AgentStateUpdate) => void>()
    await mount(container, root, <AgentPanel agents={[engineDevChildStub()]} subDispatch onOpenDispatch={onOpenDispatch} />)

    const label = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'engine-dev',
    ) as HTMLElement | undefined
    expect(label, 'child agent label should render').toBeTruthy()
    await act(async () => { label!.click() })

    expect(onOpenDispatch).toHaveBeenCalledTimes(1)
    const [dispatch, agent] = onOpenDispatch.mock.calls[0]
    expect(dispatch.id).toBe('d-child')
    expect(agent.name).toBe('engine-dev')
    // The internal floating detail panel must NOT have opened.
    expect(container.querySelector('[data-testid="floating-panel"]')).toBeNull()

    await act(async () => { root.unmount() })
    container.remove()
  })

  it('same-name dispatches render as distinct rows with independent expand state (keyed by dispatch id)', async () => {
    // Two agent pills with the same name but different dispatch IDs.
    // Before this fix, both shared the same Map key (name) so expand/select/popup
    // state was collapsed — opening one "opened" both.
    const workerA: AgentStateUpdate = {
      name: 'worker',
      id: 'dispatch-a',
      status: 'running',
      metadata: {
        displayName: 'Worker',
        type: 'agent',
        visibility: 'sticky',
        invited: true,
        task: 'task A',
        dispatches: [{ id: 'dispatch-a', task: 'task A', model: 'claude', status: 'running', conversationId: 'conv-a', startTime: 1 }],
      },
    } as unknown as AgentStateUpdate

    const workerB: AgentStateUpdate = {
      name: 'worker',
      id: 'dispatch-b',
      status: 'running',
      metadata: {
        displayName: 'Worker',
        type: 'agent',
        visibility: 'sticky',
        invited: true,
        task: 'task B',
        dispatches: [{ id: 'dispatch-b', task: 'task B', model: 'claude', status: 'running', conversationId: 'conv-b', startTime: 2 }],
      },
    } as unknown as AgentStateUpdate

    const { container, root } = render(<div />)
    await act(async () => { root.render(<AgentPanel agents={[workerA, workerB]} subDispatch />) })
    await act(async () => { await Promise.resolve() })
    // Expand the panel (rendered collapsed by default).
    if (!container.textContent?.includes('Worker')) {
      const header = Array.from(container.querySelectorAll('div')).find((el) =>
        el.textContent?.includes('Agents ('),
      ) as HTMLElement | undefined
      if (header) await act(async () => { header.click() })
    }

    // Both should render (same name, different dispatch IDs) as 2 distinct rows.
    // Before the fix, both pills shared the React key `worker`, so only one row
    // would render. "Worker" now appears at least twice.
    expect(container.textContent?.split('Worker').length).toBeGreaterThanOrEqual(3)

    await act(async () => { root.unmount() })
    container.remove()
  })
})
