/**
 * Plan-mode auto-group-movement via engine events.
 *
 * When the engine emits `engine_plan_mode_changed` (planModeEnabled:true) or
 * `engine_plan_proposal` (kind="exit"), handleNormalizedEvent commits
 * permissionMode='plan' onto the active instance and then calls
 * maybeApplyPlanModeGroupMove post-commit. That helper calls applyActiveGroupMove,
 * which moves the tab to the planning group when:
 *   - autoGroupMovement is enabled and tabGroupMode is 'manual'
 *   - the tab is running or connecting
 *   - the tab is not pinned (groupPinned:false)
 *   - the committed instance permissionMode is 'plan'
 *
 * Each test is designed to go red if the post-commit block in event-slice.ts is
 * reverted (the block that calls maybeApplyPlanModeGroupMove after set() returns).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const prefs = {
  expandToolResults: false,
  aiGeneratedTitles: false,
  autoGroupMovement: true,
  tabGroupMode: 'manual',
  doneGroupId: 'group-done',
  inProgressGroupId: 'group-inprogress',
  planningGroupId: 'group-planning',
}

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn((_tabId: string, _delay: number, _cb: () => void) => {}),
  cancelDoneGroupMove: vi.fn(() => false),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => prefs },
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import { seedMainPane } from './helpers/conversation-test-helpers'

function makeTab(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tab1',
    title: 'Test Tab',
    engineProfileId: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    pillIcon: null,
    groupId: 'group-inprogress',
    groupPinned: false,
    status: 'running' as const,
    customTitle: null,
    pillColor: null,
    permissionMode: 'auto' as const,
    queuedPrompts: [],
    historicalSessionIds: [],
    conversationId: 'conv-1',
    lastKnownSessionId: 'conv-1',
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: '',
    activeRequestId: 'req-1',
    currentActivity: 'Writing...',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
    ...overrides,
  }
}

function buildHarness(tabOverrides: Record<string, unknown> = {}, instanceMode: 'auto' | 'plan' = 'auto') {
  const moveTabToGroup = vi.fn()
  const tab = makeTab(tabOverrides)
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [tab],
    conversationPanes: seedMainPane('tab1', {
      permissionMode: instanceMode,
      sessionModel: 'mock-model',
    }),
    backend: 'api',
    moveTabToGroup,
    submit: vi.fn(),
  }
  // Simulate Zustand set(): apply the reducer result onto state so that
  // post-commit reads (get().tabs, get().conversationPanes) see the new state.
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice, moveTabToGroup }
}

describe('event-slice — plan-mode auto-group-move via engine event', () => {
  beforeEach(() => {
    prefs.autoGroupMovement = true
    prefs.tabGroupMode = 'manual'
    prefs.planningGroupId = 'group-planning'
  })

  it('case 1: moves tab to planning group on engine_plan_mode_changed (planModeEnabled:true)', () => {
    // Agent self-initiates EnterPlanMode → engine emits engine_plan_mode_changed.
    // The reducer commits permissionMode='plan' on the instance; the post-commit
    // block must then move the tab from 'group-inprogress' to 'group-planning'.
    const { slice, moveTabToGroup } = buildHarness({ status: 'running', groupId: 'group-inprogress', groupPinned: false }, 'auto')
    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed',
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'test-plan',
    } as any)
    expect(moveTabToGroup).toHaveBeenCalledWith('tab1', 'group-planning')
  })

  it('case 2: pinned tab is NOT moved when engine_plan_mode_changed fires', () => {
    // groupPinned:true — user placed this tab where they want it; auto-move must
    // not override the manual placement. The pinned guard inside applyActiveGroupMove
    // (event-slice-running-move.ts:63-69) blocks the move.
    const { slice, moveTabToGroup } = buildHarness({ status: 'running', groupId: 'group-inprogress', groupPinned: true }, 'auto')
    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed',
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'test-plan',
    } as any)
    expect(moveTabToGroup).not.toHaveBeenCalled()
  })

  it('case 3: does NOT move tab on engine_plan_proposal (kind=exit) — Layer 2 no longer mutates', () => {
    // engine_plan_proposal kind="exit" was formerly a Bug #1 defense-in-depth
    // recovery that flipped the 'auto' instance to 'plan' (and thereby triggered
    // an auto-group-move). That silent mutation is gone: the engine dropped-entry
    // defect is fixed (run_key_binding routing fix) and Layer 2 is now a pure
    // observability assertion. With no permissionMode mutation there is no
    // post-commit plan-mode group move.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { slice, moveTabToGroup } = buildHarness({ status: 'running', groupId: 'group-inprogress', groupPinned: false }, 'auto')
      slice.handleNormalizedEvent!('tab1', {
        type: 'engine_plan_proposal',
        planProposalKind: 'exit',
        planFilePath: '/tmp/plan.md',
        planSlug: 'test-plan',
      } as any)
      expect(moveTabToGroup).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('case 4: idle tab is NOT moved when engine_plan_mode_changed fires', () => {
    // status:'idle' — the tab is not actively running. Auto-group-move for plan
    // mode is a mid-run operation; an idle tab is left in place so the user sees
    // it where they last left it (parallel to the running-move guard on 'running').
    const { slice, moveTabToGroup } = buildHarness({ status: 'idle', groupId: 'group-inprogress', groupPinned: false, activeRequestId: null }, 'auto')
    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed',
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'test-plan',
    } as any)
    expect(moveTabToGroup).not.toHaveBeenCalled()
  })

  it('case 5: autoGroupMovement:false suppresses the move', () => {
    // The user has disabled automatic group movement in preferences. No move
    // should fire regardless of the plan-mode event.
    prefs.autoGroupMovement = false
    const { slice, moveTabToGroup } = buildHarness({ status: 'running', groupId: 'group-inprogress', groupPinned: false }, 'auto')
    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed',
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'test-plan',
    } as any)
    expect(moveTabToGroup).not.toHaveBeenCalled()
  })
})
