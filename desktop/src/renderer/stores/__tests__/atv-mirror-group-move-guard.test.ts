/**
 * Mirror guard on auto-group movement (regression).
 *
 * Group movement is an OWNER decision. The ATV mirror ingests the same
 * normalized event stream as the owner, so before the guard BOTH windows
 * evaluated every trigger: the mirror's copy read its own (possibly stale)
 * permission mode and forwarded moveTabToGroup to the owner — overwriting
 * the owner's correct move. Observed live: "Implement and Unpin" moved the
 * tab to in-progress in the owner (permission_mode_change), then the
 * mirror's status_change re-evaluation — still seeing mode 'plan' pre-sync —
 * moved it to planning. Done-moves were also scheduled and executed twice.
 *
 * These tests run the REAL decision bodies with the window-role mocked to
 * "mirror" and pin that neither issues any move. They go red if the mirror
 * guard is removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mirrorFlag = vi.hoisted(() => ({ value: true }))
vi.mock('../../lib/window-role', () => ({
  isMirrorWindow: () => mirrorFlag.value,
}))
vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
const scheduleDoneGroupMove = vi.fn()
vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  scheduleDoneGroupMove: (...args: unknown[]) => scheduleDoneGroupMove(...(args as [])),
  cancelDoneGroupMove: vi.fn(() => false),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      autoGroupMovement: true,
      tabGroupMode: 'manual',
      doneGroupId: 'group-done',
      inProgressGroupId: 'group-inprogress',
      planningGroupId: 'group-planning',
    }),
  },
}))

import { applyActiveGroupMove } from '../slices/event-slice-running-move'
import { maybeScheduleDoneMove } from '../slices/event-slice-done-move'
import { makeMainPane } from '../conversation-instance'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'

function makeTab(): TabState {
  return {
    id: 'tab1', groupId: 'group-ondeck', groupPinned: false, status: 'running',
  } as unknown as TabState
}

function harness() {
  const moveTabToGroup = vi.fn()
  const panes = new Map([['tab1', makeMainPane({ permissionMode: 'auto' })]])
  const get = () => ({ tabs: [makeTab()], conversationPanes: panes, moveTabToGroup }) as unknown as State
  return { moveTabToGroup, panes, get }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('mirror window never initiates auto-group moves', () => {
  it('applyActiveGroupMove is a no-op in the mirror', () => {
    mirrorFlag.value = true
    const { moveTabToGroup, panes, get } = harness()
    const moved = applyActiveGroupMove('tab1', makeTab(), panes, get, 'test')
    expect(moved).toBe(false)
    expect(moveTabToGroup).not.toHaveBeenCalled()
  })

  it('the same call in the owner window DOES move (guard is mirror-scoped)', () => {
    mirrorFlag.value = false
    const { moveTabToGroup, panes, get } = harness()
    const moved = applyActiveGroupMove('tab1', makeTab(), panes, get, 'test')
    expect(moved).toBe(true)
    expect(moveTabToGroup).toHaveBeenCalledWith('tab1', 'group-inprogress')
  })

  it('maybeScheduleDoneMove schedules nothing in the mirror', () => {
    mirrorFlag.value = true
    const { panes, get } = harness()
    maybeScheduleDoneMove('tab1', 'running', 'idle', makeTab(), panes, get, 'test')
    expect(scheduleDoneGroupMove).not.toHaveBeenCalled()
  })

  it('the same done transition in the owner window schedules the move', () => {
    mirrorFlag.value = false
    const { panes, get } = harness()
    maybeScheduleDoneMove('tab1', 'running', 'idle', makeTab(), panes, get, 'test')
    expect(scheduleDoneGroupMove).toHaveBeenCalledTimes(1)
  })
})
