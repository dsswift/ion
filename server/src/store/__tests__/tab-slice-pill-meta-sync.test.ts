/**
 * tab-slice — the pill color action pushes a desktop_tab_meta delta
 *
 * Pins the contract that setTabPillColor is not a local-state-only mutation:
 * it also fires tabMetaChanged so the server pushes an event-driven
 * desktop_tab_meta delta to iOS immediately, instead of iOS waiting for the
 * next 5 s snapshot poll tick.
 *
 * Cases:
 *   1. setTabPillColor with a string sends { tabId, pillColor: <string> }.
 *   2. setTabPillColor with null (explicit clear) sends { tabId, pillColor: null }
 *      — the null must ride through, not be dropped or coerced to undefined.
 *
 * Regression direction: removing the tabMetaChanged call from the action
 * turns the assertions red because mockTabMetaChanged is never invoked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../rendererLogger', () => ({
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

vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: {
    getState: vi.fn(() => ({})),
  },
}))

const mockTabMetaChanged = vi.fn()

vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  tabMetaChanged: (...args: any[]) => mockTabMetaChanged(...args),
  closeTab: vi.fn(),
  createTab: vi.fn(),
  deleteTabContent: vi.fn(),
  saveSessionLabel: vi.fn(),
  setPermissionMode: vi.fn(),
  start: vi.fn(),
  terminalDestroy: vi.fn(),
}))

import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'

function buildHarness(tabId: string) {
  const state: any = {
    tabs: [{ id: tabId, pillColor: null }],
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
