/**
 * tab-slice — pill color/icon actions push a desktop_tab_meta delta
 *
 * Pins the contract that setTabPillColor / setTabPillIcon are not
 * local-state-only mutations: each also fires window.ion.tabMetaChanged so
 * the main process pushes an event-driven desktop_tab_meta delta to iOS
 * immediately, instead of iOS waiting for the next 5 s snapshot poll tick.
 * Every OTHER tab field this file mutates (renameTab → title, moveTabToGroup
 * → groupId) already has this send; pill color/icon were the omission this
 * test locks down.
 *
 * Cases:
 *   1. setTabPillColor with a string sends { tabId, pillColor: <string> }.
 *   2. setTabPillColor with null (explicit clear) sends { tabId, pillColor: null }
 *      — the null must ride through, not be dropped or coerced to undefined.
 *   3. setTabPillIcon with a string sends { tabId, pillIcon: <string> }.
 *   4. setTabPillIcon with null (explicit clear) sends { tabId, pillIcon: null }.
 *
 * Regression direction: reverting the fix removes the window.ion.tabMetaChanged
 * call from either action, and the corresponding assertion goes red because
 * mockTabMetaChanged is never invoked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../../rendererLogger', () => ({
  rTrace: vi.fn(),
  rDebug: vi.fn(),
  rInfo: vi.fn(),
  rWarn: vi.fn(),
  rError: vi.fn(),
}))

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'msg-x'),
  playNotificationIfHidden: vi.fn(async () => {}),
  cancelDoneGroupMove: vi.fn(() => false),
  scheduleDoneGroupMove: vi.fn(),
  isReusableBlankConversationTab: vi.fn(() => false),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: vi.fn(() => ({
      tabGroups: [],
      tabGroupMode: 'off',
    })),
  },
  getEffectiveTabGroups: (g: any) => g,
}))

const mockTabMetaChanged = vi.fn()

;(globalThis as any).window = {
  ion: {
    tabMetaChanged: mockTabMetaChanged,
  },
}

import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'

function buildHarness(tabId: string) {
  const state: any = {
    tabs: [{ id: tabId, pillColor: null, pillIcon: null }],
  }
  const set = (patch: any) => {
    if (typeof patch === 'function') Object.assign(state, patch(state))
    else Object.assign(state, patch)
  }
  const get = () => state
  const slice = createTabSlice(set, get) as Partial<State>
  return { state, slice }
}

beforeEach(() => {
  mockTabMetaChanged.mockClear()
})

describe('setTabPillColor', () => {
  it('sets local state AND pushes a desktop_tab_meta delta with the new color', () => {
    const { state, slice } = buildHarness('tab1')

    slice.setTabPillColor!('tab1', '#f08c4a')

    expect(state.tabs[0].pillColor).toBe('#f08c4a')
    expect(mockTabMetaChanged).toHaveBeenCalledTimes(1)
    expect(mockTabMetaChanged).toHaveBeenCalledWith({ tabId: 'tab1', pillColor: '#f08c4a' })
  })

  it('propagates an explicit null (clear) rather than dropping the field', () => {
    const { state, slice } = buildHarness('tab1')
    state.tabs[0].pillColor = '#f08c4a'

    slice.setTabPillColor!('tab1', null)

    expect(state.tabs[0].pillColor).toBeNull()
    expect(mockTabMetaChanged).toHaveBeenCalledTimes(1)
    expect(mockTabMetaChanged).toHaveBeenCalledWith({ tabId: 'tab1', pillColor: null })
  })
})

describe('setTabPillIcon', () => {
  it('sets local state AND pushes a desktop_tab_meta delta with the new icon', () => {
    const { state, slice } = buildHarness('tab1')

    slice.setTabPillIcon!('tab1', 'diamond')

    expect(state.tabs[0].pillIcon).toBe('diamond')
    expect(mockTabMetaChanged).toHaveBeenCalledTimes(1)
    expect(mockTabMetaChanged).toHaveBeenCalledWith({ tabId: 'tab1', pillIcon: 'diamond' })
  })

  it('propagates an explicit null (clear) rather than dropping the field', () => {
    const { state, slice } = buildHarness('tab1')
    state.tabs[0].pillIcon = 'diamond'

    slice.setTabPillIcon!('tab1', null)

    expect(state.tabs[0].pillIcon).toBeNull()
    expect(mockTabMetaChanged).toHaveBeenCalledTimes(1)
    expect(mockTabMetaChanged).toHaveBeenCalledWith({ tabId: 'tab1', pillIcon: null })
  })
})
