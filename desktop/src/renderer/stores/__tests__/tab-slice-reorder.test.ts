/**
 * tab-slice — reorderTabs
 *
 * reorderTabs takes an ORDER OF IDS, not a full TabState[] replacement array.
 * The store applies that ordering to its OWN current `tabs`, so a forwarded
 * call from the Studio mirror (whose own `tabs` copy can be a beat behind the
 * owner's) can never silently drop a tab the mirror doesn't know about yet,
 * or resurrect one the owner has since closed.
 *
 * Regression coverage: the prior implementation was `set({ tabs: reorderedTabs })`
 * — a bare replacement of the whole array with whatever the caller sent. A
 * forwarded call from a mirror whose `tabs` snapshot excluded a tab the owner
 * had created (or included one the owner had since closed) would silently
 * apply that stale shape to the owner's authoritative state.
 */
import { describe, it, expect, vi } from 'vitest'

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
      stashedManualTabAssignments: {},
      setStashedManualTabAssignments: vi.fn(),
      defaultTallConversation: false,
      expandOnTabSwitch: false,
    })),
  },
  getEffectiveTabGroups: (g: any) => g,
}))

import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'

function makeTab(id: string) {
  return { id, title: id } as unknown as State['tabs'][number]
}

function buildHarness(tabIds: string[]) {
  const state: any = { tabs: tabIds.map(makeTab) }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createTabSlice(set, get) as State
  return { state, slice }
}

describe('reorderTabs — ids-only ordering, applied against the store\'s own tabs', () => {
  it('reorders to match the given id order', () => {
    const { state, slice } = buildHarness(['a', 'b', 'c'])
    slice.reorderTabs(['c', 'a', 'b'])
    expect(state.tabs.map((t: any) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('appends a tab the caller did not mention, in its existing relative position', () => {
    // The store has a tab ('d') the caller's ordering never named — e.g. a
    // tab created after a Studio-mirror caller's own tabs snapshot was taken.
    const { state, slice } = buildHarness(['a', 'b', 'c', 'd'])
    slice.reorderTabs(['c', 'a'])
    // 'b' and 'd' are unmentioned; both survive, appended after the named
    // ids, in their original relative order.
    expect(state.tabs.map((t: any) => t.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('ignores an id in the ordering that no longer names a real tab', () => {
    // The caller's ordering names a tab the store has already closed — a
    // stale/foreign id must be dropped, never resurrected.
    const { state, slice } = buildHarness(['a', 'b'])
    slice.reorderTabs(['ghost', 'b', 'a'])
    expect(state.tabs.map((t: any) => t.id)).toEqual(['b', 'a'])
  })

  it('never drops or duplicates a tab when the caller only reorders a subset (group reorder)', () => {
    // Mirrors the TabStripGroupPickerDropdown call site: only one group's ids
    // are named, in their new order; every tab outside the group must
    // survive untouched.
    const { state, slice } = buildHarness(['x1', 'g1', 'g2', 'g3', 'x2'])
    slice.reorderTabs(['g3', 'g1', 'g2'])
    expect(state.tabs.map((t: any) => t.id)).toEqual(['g3', 'g1', 'g2', 'x1', 'x2'])
    expect(state.tabs).toHaveLength(5)
  })

  it('a duplicate id in the ordering is applied only once', () => {
    const { state, slice } = buildHarness(['a', 'b', 'c'])
    slice.reorderTabs(['b', 'b', 'a'])
    expect(state.tabs.map((t: any) => t.id)).toEqual(['b', 'a', 'c'])
  })

  it('an empty ordering leaves every tab in its existing order', () => {
    const { state, slice } = buildHarness(['a', 'b', 'c'])
    slice.reorderTabs([])
    expect(state.tabs.map((t: any) => t.id)).toEqual(['a', 'b', 'c'])
  })
})
