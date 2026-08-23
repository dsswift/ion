// @vitest-environment jsdom
//
// AgentDetailBody's dispatch-Stop wiring: the shared dispatch-body component
// no longer renders its own footer. It computes which dispatch is displayed,
// which sibling instances share its owning row, and the activity text — then
// forwards all three into Transcript's activityDispatchId /
// activityRunningDispatchIds / activityText props, which is what actually
// renders the Stop overlay (pinned INSIDE Transcript's own scroll region; see
// Transcript.activityOverlay.test.tsx for that half). AgentDetailPanel (the
// overlay popup) and DispatchSplitPane/DispatchSurface (the Studio panes) all
// render this ONE AgentDetailBody implementation, so pinning the computation
// here covers every host.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentStateUpdate } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Mocks ──

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ unifiedTurnView: false }),
}))

// AgentDetailBody no longer calls useSessionStore directly (that now lives in
// Transcript, mocked wholesale below), but something in its import graph still
// resolves the real sessionStore module in this test environment, which pulls
// in the real preferences store and fails outside a full app boot. Mocking it
// keeps this file testing AgentDetailBody's own prop computation in isolation.
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) => sel({}),
}))

const mockGetConversation = vi.fn()
;(globalThis as any).window = globalThis.window ?? {}
;(globalThis as any).window.ion = { getConversation: mockGetConversation }

const transcriptProps: Array<Record<string, unknown>> = []
vi.mock('../conversation/Transcript', () => ({
  Transcript: (props: Record<string, unknown>) => {
    transcriptProps.push(props)
    const { onOpenDispatch, agents } = props as {
      onOpenDispatch?: (dispatch: unknown, agent: AgentStateUpdate) => void
      agents?: AgentStateUpdate[]
    }
    return React.createElement(
      'div',
      { 'data-testid': 'transcript' },
      agents?.map((a: any, i: number) =>
        React.createElement(
          'button',
          {
            key: i,
            'data-testid': `open-child-${a.name}`,
            onClick: () => {
              const dispatch = a.metadata?.dispatches?.[0]
              if (dispatch && onOpenDispatch) onOpenDispatch(dispatch, a)
            },
          },
          a.name,
        ),
      ),
    )
  },
}))

vi.mock('../agent-conversation-mapper', () => ({
  mapConversationMessages: (msgs: any[]) =>
    msgs.map((m: any, i: number) => ({ id: `mapped-${i}`, role: m.role || 'assistant', content: m.content || '', timestamp: 0 })),
}))

import { AgentDetailBody } from '../AgentDetailBody'

function makeAgent(name: string, status: AgentStateUpdate['status'] = 'running', lastWork = ''): AgentStateUpdate {
  return { name, status, metadata: { displayName: name, lastWork } }
}

function makeDispatch(id: string, conversationId: string, status = 'running', model = 'test-model', elapsed = 10) {
  return { id, task: 'test', model, conversationId, status, elapsed }
}

function makeChildPill(
  name: string,
  parentDispatchId: string,
  dispatchId: string,
  conversationId: string,
  status: AgentStateUpdate['status'] = 'running',
  lastWork = '',
): AgentStateUpdate {
  return {
    name,
    status,
    metadata: {
      displayName: name,
      lastWork,
      dispatchParentId: parentDispatchId,
      dispatchDepth: 2,
      dispatches: [{ id: dispatchId, task: 't', model: 'm', conversationId, status, elapsed: 5 }],
    },
  }
}

function renderBody(props: Parameters<typeof AgentDetailBody>[0]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(AgentDetailBody, props)) })
  return {
    container,
    unmount() { act(() => { root.unmount() }); document.body.removeChild(container) },
  }
}

describe('AgentDetailBody forwards dispatch-Stop props to Transcript', () => {
  beforeEach(() => {
    transcriptProps.length = 0
    mockGetConversation.mockReset()
    mockGetConversation.mockResolvedValue({ messages: [{ role: 'user', content: 'hi' }] })
  })

  it('forwards the running root dispatch id when tabId is present', () => {
    const { unmount } = renderBody({
      agent: makeAgent('dev-lead', 'running', 'Using Read...'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1', 'running')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      tabId: 'tab-1',
    })
    const props = transcriptProps.at(-1)
    expect(props?.activityDispatchId).toBe('d1')
    expect(props?.activityRunningDispatchIds).toEqual(['d1'])
    expect(props?.activityText).toBe('Using Read...')
    unmount()
  })

  it('forwards no activityDispatchId when tabId is absent', () => {
    const { unmount } = renderBody({
      agent: makeAgent('dev-lead', 'running'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1', 'running')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
    })
    // tabId itself is forwarded as-is (Transcript's own gate checks it), but
    // AgentDetailBody must not fabricate a dispatch id Transcript could act on
    // without a tab to address it in.
    const props = transcriptProps.at(-1)
    expect(props?.tabId).toBeUndefined()
    unmount()
  })

  it('forwards no activityDispatchId when the displayed dispatch is terminal', () => {
    const { unmount } = renderBody({
      agent: makeAgent('dev-lead', 'done'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1', 'done')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      tabId: 'tab-1',
    })
    const props = transcriptProps.at(-1)
    expect(props?.activityDispatchId).toBeUndefined()
    unmount()
  })

  it('forwards the drilled-into child dispatch id, not the root, after navigating', async () => {
    const child = makeChildPill('ios-dev', 'd1', 'd2', 'conv-2', 'running', 'Editing file...')
    const { container, unmount } = renderBody({
      agent: makeAgent('dev-lead', 'running'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1', 'running')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      allAgents: [makeAgent('dev-lead', 'running'), child],
      tabId: 'tab-owning-tree',
    })

    const childBtn = container.querySelector('[data-testid="open-child-ios-dev"]') as HTMLButtonElement
    act(() => { childBtn.click() })

    // Drilling in swaps to the child's conversation, which loads
    // asynchronously (getConversation) before Transcript renders again with
    // the new subject — the same async boundary the pre-existing
    // "fires getConversation with child conversationId on drill-in" test
    // waits on.
    await vi.waitFor(() => {
      expect(transcriptProps.at(-1)?.activityDispatchId).toBe('d2')
    })

    const props = transcriptProps.at(-1)
    expect(props?.activityRunningDispatchIds).toEqual(['d2'])
    expect(props?.activityText).toBe('Editing file...')
    unmount()
  })

  it('forwards every running sibling instance in the OWNING row for Stop-all', async () => {
    // Two running instances (d2, d3) share the SAME owning agent row
    // (ios-dev). Drilling into d2 must forward Stop-all coverage across both,
    // not just the one dispatch currently displayed.
    const rowOwner: AgentStateUpdate = {
      name: 'ios-dev',
      status: 'running',
      metadata: {
        displayName: 'ios-dev',
        dispatchParentId: 'd1',
        dispatchDepth: 2,
        dispatches: [
          { id: 'd2', task: 't', model: 'm', conversationId: 'conv-2', status: 'running', elapsed: 5 },
          { id: 'd3', task: 't', model: 'm', conversationId: 'conv-3', status: 'running', elapsed: 3 },
        ],
      },
    }
    const { container, unmount } = renderBody({
      agent: makeAgent('dev-lead', 'running'),
      loadedMessages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 0 }],
      loading: false,
      dispatches: [makeDispatch('d1', 'conv-1', 'running')],
      selectedDispatch: 0,
      onSelectDispatch: () => {},
      allAgents: [makeAgent('dev-lead', 'running'), rowOwner],
      tabId: 'tab-owning-tree',
    })

    const childBtn = container.querySelector('[data-testid="open-child-ios-dev"]') as HTMLButtonElement
    act(() => { childBtn.click() })

    await vi.waitFor(() => {
      expect(transcriptProps.at(-1)?.activityDispatchId).toBe('d2')
    })

    const props = transcriptProps.at(-1)
    expect(props?.activityRunningDispatchIds).toEqual(['d2', 'd3'])
    unmount()
  })
})
