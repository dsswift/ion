// @vitest-environment jsdom
/**
 * What the Studio mirror does with a backlog of `studio:tabs-sync` pushes:
 * it applies only the newest one per Environment, keeps the settled history
 * a push leaves out, and keeps a just-clicked conversation selected while the
 * pushes the owner published before handling the click drain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

const { onFrame } = vi.hoisted(() => ({ onFrame: vi.fn() }))
vi.mock('../../../host/host-instance', () => ({ host: { onFrame } }))
vi.mock('../../connection/catalog', () => ({ isManageOnlyEnvironment: () => false }))

import { _resetLocalOwnerActiveTabForTest, clearEnvironmentSyncCursors, initTabsSyncFromWire } from '../secondary-store'
import { _resetPendingSelectionForTest, answerPendingSelection, beginPendingSelection } from '../pending-selection'

function tab(id: string) {
  return { id, conversationId: `conv-${id}`, title: id, customTitle: null, workingDirectory: '/repo', hasChosenDirectory: true, additionalDirs: [] }
}

let frameHandler: ((environmentId: string, frame: StudioFrame) => void) | undefined
let revision = 1000

function push(payload: Record<string, unknown>): void {
  frameHandler?.(LOCAL_ENVIRONMENT_ID, { type: 'studio_event', channel: 'studio:tabs-sync', payload: { revision: ++revision, ...payload } })
}

const ids = (list: Array<{ id: string }>) => list.map((t) => t.id)

beforeEach(() => {
  useSessionStore.setState({ tabs: [], settledHistory: [], activeTabId: undefined, conversationPanes: new Map(), tabsReady: false })
  clearEnvironmentSyncCursors(LOCAL_ENVIRONMENT_ID)
  _resetLocalOwnerActiveTabForTest()
  _resetPendingSelectionForTest()
  vi.useFakeTimers()
  onFrame.mockImplementation((cb: typeof frameHandler) => {
    frameHandler = cb
    return vi.fn()
  })
  initTabsSyncFromWire()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('tabs-sync backlog', () => {
  it('applies only the newest of the pushes waiting together', () => {
    const setState = vi.spyOn(useSessionStore, 'setState')
    push({ tabs: [tab('a')] })
    push({ tabs: [tab('a'), tab('b')] })
    push({ tabs: [tab('a'), tab('b'), tab('c')] })
    expect(useSessionStore.getState().tabs).toEqual([])
    vi.runOnlyPendingTimers()
    expect(ids(useSessionStore.getState().tabs)).toEqual(['a', 'b', 'c'])
    expect(setState).toHaveBeenCalledTimes(1)
    setState.mockRestore()
  })

  it('keeps the settled history a push leaves out, including one a replaced push carried', () => {
    push({ tabs: [tab('a')], settledHistory: [tab('old')] })
    vi.runOnlyPendingTimers()
    push({ tabs: [tab('a'), tab('b')] })
    vi.runOnlyPendingTimers()
    expect(ids(useSessionStore.getState().settledHistory)).toEqual(['old'])

    push({ tabs: [tab('a')], settledHistory: [tab('old'), tab('b')] })
    push({ tabs: [tab('a'), tab('c')] })
    vi.runOnlyPendingTimers()
    expect(ids(useSessionStore.getState().tabs)).toEqual(['a', 'c'])
    expect(ids(useSessionStore.getState().settledHistory)).toEqual(['old', 'b'])
  })

  it('takes the settled history from the welcome snapshot', () => {
    frameHandler?.(LOCAL_ENVIRONMENT_ID, {
      type: 'studio_snapshot',
      snapshot: { tabs: [tab('a')], settledHistory: [tab('old')], settings: {} as never, worktrees: {} as never, terminals: { revision: 0, panes: [], openTabIds: [] } as never, automations: [], engine: {} as never, presence: { entries: [], driving: {} } },
    })
    expect(ids(useSessionStore.getState().settledHistory)).toEqual(['old'])
  })
})

describe('a selection the owner has not confirmed yet', () => {
  function clickB(): void {
    useSessionStore.setState({ activeTabId: 'b' })
    beginPendingSelection('b')
  }

  beforeEach(() => {
    push({ tabs: [tab('a'), tab('b')], activeTabIndex: 0 })
    vi.runOnlyPendingTimers()
    expect(useSessionStore.getState().activeTabId).toBe('a')
  })

  it('survives pushes the owner published before it handled the click', () => {
    clickB()
    push({ tabs: [tab('a'), tab('b')], activeTabIndex: 0 })
    vi.runOnlyPendingTimers()
    expect(useSessionStore.getState().activeTabId).toBe('b')

    // Still in flight when the answer came back: the hold stays.
    push({ tabs: [tab('a'), tab('b')], activeTabIndex: 0 })
    answerPendingSelection('b')
    vi.runOnlyPendingTimers()
    expect(useSessionStore.getState().activeTabId).toBe('b')

    push({ tabs: [tab('a'), tab('b')], activeTabIndex: 1 })
    vi.runOnlyPendingTimers()
    expect(useSessionStore.getState().activeTabId).toBe('b')
  })

  it('follows the owner again once it has answered and moved on', () => {
    clickB()
    answerPendingSelection('b')
    // Published after the owner handled the click, then another client moved it.
    push({ tabs: [tab('a'), tab('b')], activeTabIndex: 0 })
    vi.runOnlyPendingTimers()
    expect(useSessionStore.getState().activeTabId).toBe('a')
  })

  it('without a pending selection, the local owner stays authoritative', () => {
    useSessionStore.setState({ activeTabId: 'b' })
    push({ tabs: [tab('a'), tab('b')], activeTabIndex: 0 })
    vi.runOnlyPendingTimers()
    expect(useSessionStore.getState().activeTabId).toBe('a')
  })
})
