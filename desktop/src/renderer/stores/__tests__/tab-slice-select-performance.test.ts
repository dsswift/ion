// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../components/TerminalPanel', () => ({ destroyTerminalInstance: vi.fn() }))
vi.mock('../../rendererLogger', () => ({ rTrace: vi.fn(), rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(), isReusableBlankConversationTab: vi.fn(() => false),
  initialModelOverride: null, initialPermissionMode: 'default', initialThinkingEffort: null,
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ expandOnTabSwitch: false, defaultTallTerminal: false, defaultTallConversation: false }) },
  getEffectiveTabGroups: (groups: unknown) => groups,
}))
vi.mock('../slices/engine-slice-create', () => ({ createConversationTabAction: () => vi.fn() }))

import type { TabState } from '../../../shared/types'
import type { State, StoreGet, StoreSet } from '../session-store-types'
import { createTabSlice } from '../slices/tab-slice'

function tab(id: string): TabState {
  return {
    id,
    title: id,
    customTitle: null,
    status: 'idle',
    workingDirectory: '/repo',
    conversationId: null,
    manualUnread: true,
    lastVisitedAt: null,
  } as TabState
}

describe('selectTab state cost', () => {
  it('acknowledges review when the selected row is already active', () => {
    const markTabRead = vi.fn()
    const state = {
      tabs: [tab('a')],
      activeTabId: 'a',
      isExpanded: true,
      settingsOpen: false,
      tallViewTabId: null,
      terminalTallTabId: null,
      settledHistory: [],
      conversationPanes: new Map(),
      markTabRead,
    } as unknown as State
    const set: StoreSet = (update) => {
      const patch = typeof update === 'function' ? update(state) : update
      Object.assign(state, patch)
    }
    const get: StoreGet = () => state
    Object.assign(state, createTabSlice(set, get))

    state.selectTab('a')

    expect(markTabRead).toHaveBeenCalledWith('a')
  })

  it('preserves the tabs array until the active-tab notifier stamps the new visit', () => {
    const tabs = [tab('a'), tab('b')]
    const state = {
      tabs,
      activeTabId: 'a',
      isExpanded: true,
      settingsOpen: false,
      tallViewTabId: null,
      terminalTallTabId: null,
      settledHistory: [],
      conversationPanes: new Map(),
    } as unknown as State
    const set: StoreSet = (update) => {
      const patch = typeof update === 'function' ? update(state) : update
      Object.assign(state, patch)
    }
    const get: StoreGet = () => state
    Object.assign(state, createTabSlice(set, get))

    state.selectTab('b')

    expect(state.activeTabId).toBe('b')
    expect(state.tabs).toBe(tabs)
    expect(state.tabs[1]).toMatchObject({ manualUnread: true, lastVisitedAt: null })
  })
})
