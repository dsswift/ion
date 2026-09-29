// @vitest-environment jsdom
/**
 * `StatusDrawer`'s mount effect calls `host.shell.engineGetContextBreakdown`
 * on every host: the verb is wire-served (browser-shell-bridge.ts
 * SHELL_INVOKE), so a browser Studio client reporting only the bridged
 * capabilities must reach it on mount, not skip it.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../AgentDetailPanel', () => ({ AgentDetailPanel: () => React.createElement('div') }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../preferences', () => ({ usePreferencesStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ preferredModel: 'm' }) }))
vi.mock('@ion/server/lib/window-role', () => ({ windowRole: () => 'overlay' }))
vi.mock('zustand/shallow', () => ({ useShallow: (selector: unknown) => selector }))
vi.mock('./StatusDrawerParts', () => ({
  UsageBar: () => null, SectionHeader: () => null, elapsedStr: () => '', ProportionGraph: () => null,
  groupCategories: () => new Map(), CategoryRow: () => null, CopyButton: () => null, ModelBreakdownRows: () => null,
  KIND_ORDER: [], KIND_LABEL: {}, KIND_COLOR: {}, formatMs: () => '',
}))

const engineGetContextBreakdown = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../host/host-instance', () => ({
  host: { shell: { engineGetContextBreakdown }, capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'] },
}))

const tabId = 'tab-drawer-1'
const state = {
  closeStatusDrawer: vi.fn(),
  openDispatchPreview: vi.fn(),
  statusDrawerDispatchId: null as string | null,
  tabs: [{ id: tabId }],
  activeTabId: tabId,
  conversationPanes: new Map([[tabId, {
    activeInstanceId: 'inst-1',
    instances: [{ id: 'inst-1', statusFields: null, agentStates: [], dispatchTelemetry: [], contextBreakdown: null }],
  }]]),
}
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (snapshot: typeof state) => unknown) => selector(state),
    { getState: () => state, setState: vi.fn() },
  ),
}))

import { StatusDrawer } from '../StatusDrawer'

afterEach(() => { document.body.replaceChildren() })

describe('StatusDrawer context breakdown', () => {
  it('requests the context breakdown on mount on a browser host', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    expect(() => act(() => { root.render(React.createElement(StatusDrawer)) })).not.toThrow()
    expect(engineGetContextBreakdown).toHaveBeenCalledWith(tabId)
    act(() => root.unmount())
  })
})
