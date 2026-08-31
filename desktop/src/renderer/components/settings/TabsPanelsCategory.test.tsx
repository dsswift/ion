// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const setStudioTabStripVisible = vi.fn()
const state = new Proxy({
  studioTabStripVisible: true,
  setStudioTabStripVisible,
  tabGroupMode: 'off',
  tabGroups: [],
  inProgressGroupId: null,
  doneGroupId: null,
  planningGroupId: null,
  autoGroupMovement: false,
  expandOnTabSwitch: true,
  keepExplorerOnCollapse: false,
  keepTerminalOnCollapse: false,
  keepGitPanelOnCollapse: false,
  keepStatusDrawerOnCollapse: false,
  tabRecoveryEnabled: true,
  inboxAutoSettleDays: 0,
  inboxAutoSettleOnMerge: true,
}, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn() })

vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }),
  getEffectiveTabGroups: () => [],
}))
vi.mock('../../stores/sessionStore', () => ({ useSessionStore: { getState: () => ({ tabs: [] }), setState: vi.fn() } }))
vi.mock('../../theme', () => ({ useColors: () => ({ surfacePrimary: '#000', containerBorder: '#111', accent: '#222', textOnAccent: '#fff', textSecondary: '#ccc', textTertiary: '#aaa', textPrimary: '#fff', infoFg: '#00f', warningFg: '#ff0', successFg: '#0f0' }) }))
vi.mock('../../hooks/useManualReorder', () => ({ useManualReorder: () => ({ onItemPointerDown: vi.fn() }) }))

import { TabsPanelsCategory } from './TabsPanelsCategory'

let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  setStudioTabStripVisible.mockClear()
})

describe('TabsPanelsCategory Studio Tab Strip setting', () => {
  it('shows the default-on toggle and changes only its visibility setting', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root?.render(<TabsPanelsCategory />))

    const label = Array.from(host.querySelectorAll('span')).find((node) => node.textContent === 'Show Tab Strip in Ion Studio')
    expect(label).toBeDefined()
    const toggle = label?.parentElement?.querySelector('div') as HTMLDivElement
    act(() => toggle.click())
    expect(setStudioTabStripVisible).toHaveBeenCalledWith(false)
  })
})
