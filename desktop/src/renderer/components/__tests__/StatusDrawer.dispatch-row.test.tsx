// @vitest-environment jsdom
//
// A running-dispatch row in the Status Drawer opens that dispatch in Studio's
// inline dispatch split, on every Studio client. The row used to branch on a
// window role guessed from the page's entry file, which sent a browser client
// down a path only the deleted Overlay window used.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ preferredModel: 'm' }),
}))
vi.mock('../../host/host-instance', () => ({
  host: { shell: { engineGetContextBreakdown: vi.fn(async () => {}) }, capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'] },
}))
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
  openDispatchSplit: vi.fn(),
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

vi.mock('@ion/server/store/sessionStore', () => ({
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

describe('StatusDrawer running-dispatch row', () => {
  afterEach(() => { document.body.replaceChildren() })

  it('opens the clicked dispatch in the inline dispatch split', () => {
    const { container, unmount } = render()
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('child'))
    expect(row).toBeDefined()
    act(() => { row!.click() })
    expect(state.openDispatchSplit).toHaveBeenCalledWith({ agentName: 'child', dispatchId })
    unmount()
  })
})
