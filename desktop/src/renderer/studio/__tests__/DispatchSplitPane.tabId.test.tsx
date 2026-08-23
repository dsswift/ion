// @vitest-environment jsdom
//
// Regression pin: DispatchSplitPane (the Studio center's inline dispatch
// preview) must pass the active tabId into the shared AgentDetailBody.
// Without it, every Stop control inside AgentDetailBody's footer and its
// nested AgentRows is gated off — the same class of bug ConversationView had
// for the main conversation, but for the Studio split pane.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agentDetailBodyProps: Array<Record<string, unknown>> = []
vi.mock('../../components/AgentDetailBody', () => ({
  AgentDetailBody: (props: Record<string, unknown>) => {
    agentDetailBodyProps.push(props)
    return React.createElement('div', { 'data-testid': 'agent-detail-body' })
  },
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../components/agent-panel-helpers', () => ({
  meta: (agent: { name: string }) => agent.name,
}))

const tabId = 'studio-tab-1'
const subjectAgent = { name: 'dev-lead', status: 'running', metadata: { displayName: 'dev-lead' } }
const dispatchData = { slicedMsgs: [], isLoading: false, dispatches: [{ id: 'd1', task: 't', model: 'm', conversationId: 'c1', status: 'running' }], dispIdx: 0 }

vi.mock('../dispatch-split-state', () => ({
  activeDispatchSplit: () => ({ agentName: 'dev-lead', dispatchId: 'd1' }),
}))
vi.mock('../../hooks/useDispatchTranscript', () => ({
  resolveSubjectAgent: () => subjectAgent,
  useDispatchTranscript: () => ({
    resolveDispatchData: () => dispatchData,
    loadSingleConversation: vi.fn(),
  }),
}))

const state = {
  dispatchSplit: {},
  activeTabId: tabId,
  closeDispatchSplit: vi.fn(),
  conversationPanes: new Map([[tabId, {
    activeInstanceId: 'inst-1',
    instances: [{ id: 'inst-1', agentStates: [subjectAgent], dispatchTelemetry: [] }],
  }]]),
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (snapshot: typeof state) => unknown) => selector(state),
    { getState: () => state, setState: vi.fn() },
  ),
}))

import { DispatchSplitPane } from '../DispatchSplitPane'

function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(DispatchSplitPane)) })
  return { container, unmount() { act(() => { root.unmount() }); document.body.removeChild(container) } }
}

describe('DispatchSplitPane tabId wiring', () => {
  beforeEach(() => { agentDetailBodyProps.length = 0 })
  afterEach(() => { document.body.replaceChildren() })

  it('forwards the active tabId to the shared AgentDetailBody', () => {
    const { unmount } = render()
    expect(agentDetailBodyProps.at(-1)?.tabId).toBe(tabId)
    unmount()
  })
})
