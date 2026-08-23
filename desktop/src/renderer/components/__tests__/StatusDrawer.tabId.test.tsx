// @vitest-environment jsdom
//
// Regression pin: StatusDrawer must pass the owning tabId into AgentDetailPanel
// for the deep-linked dispatch. Without it, the drawer-opened dispatch preview
// renders no Stop control even though AgentDetailPanel/AgentDetailBody support
// one — the tabId simply never reaches them.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agentDetailPanelProps: Array<Record<string, unknown>> = []
vi.mock('../AgentDetailPanel', () => ({
  AgentDetailPanel: (props: Record<string, unknown>) => {
    agentDetailPanelProps.push(props)
    return React.createElement('div', { 'data-testid': 'agent-detail-panel' })
  },
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ preferredModel: 'm' }),
}))
vi.mock('../../lib/window-role', () => ({ windowRole: () => 'overlay' }))
vi.mock('zustand/shallow', () => ({ useShallow: (selector: unknown) => selector }))
vi.mock('./StatusDrawerParts', () => ({
  UsageBar: () => null, SectionHeader: () => null, elapsedStr: () => '', ProportionGraph: () => null,
  groupCategories: () => new Map(), CategoryRow: () => null, CopyButton: () => null, ModelBreakdownRows: () => null,
  KIND_ORDER: [], KIND_LABEL: {}, KIND_COLOR: {}, formatMs: () => '',
}))

const tabId = 'tab-drawer-1'
const dispatchId = 'dispatch-d2'
const state = {
  closeStatusDrawer: vi.fn(),
  openDispatchPreview: vi.fn(),
  statusDrawerDispatchId: dispatchId as string | null,
  tabs: [{ id: tabId }],
  activeTabId: tabId,
  conversationPanes: new Map([[tabId, {
    activeInstanceId: 'inst-1',
    instances: [{
      id: 'inst-1',
      statusFields: null,
      agentStates: [
        { name: 'root', status: 'running', metadata: { displayName: 'root', dispatchParentId: '', dispatchDepth: 1, dispatches: [{ id: 'd1', task: 't', model: 'm', conversationId: 'c1', status: 'running' }] } },
        { name: 'child', status: 'running', metadata: { displayName: 'child', dispatchParentId: 'd1', dispatchDepth: 2, dispatches: [{ id: dispatchId, task: 't', model: 'm', conversationId: 'c2', status: 'running' }] } },
      ],
      dispatchTelemetry: [],
      contextBreakdown: null,
    }],
  }]]),
}

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (snapshot: typeof state) => unknown) => selector(state),
    { getState: () => state, setState: vi.fn() },
  ),
}))

import { StatusDrawer } from '../StatusDrawer'

function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(React.createElement(StatusDrawer)) })
  return { container, unmount() { act(() => { root.unmount() }); document.body.removeChild(container) } }
}

describe('StatusDrawer deep-link tabId wiring', () => {
  beforeEach(() => { agentDetailPanelProps.length = 0 })
  afterEach(() => { document.body.replaceChildren() })

  it('forwards the active tabId to the deep-linked AgentDetailPanel', () => {
    const { unmount } = render()
    expect(agentDetailPanelProps.at(-1)?.tabId).toBe(tabId)
    unmount()
  })
})
