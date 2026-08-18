/**
 * handleStatusChange — permissionDenied clear is gated on a genuine
 * active→terminal transition.
 *
 * REGRESSION: opening a conversation that ended on a plan proposal showed the
 * plan-ready card (synthesized on restore from message history in
 * useTabRestoration-engine.ts), then the card vanished a few seconds later.
 * Cause: the engine emits passive `state=idle` snapshots every few seconds
 * (reconcile reason=query / heartbeat) after restore. Those surface as
 * handleStatusChange(tab, 'idle', 'idle') and the handler UNCONDITIONALLY
 * cleared permissionDenied on any idle status — wiping the just-synthesized
 * denial that backs the card.
 *
 * The fix gates the denial clear on the tab having been ACTIVE
 * (running/connecting) before the transition. A passive idle→idle /
 * completed→idle tick no longer clears the denial. A real run finishing
 * (running→idle) still clears a stale denial as before.
 *
 * Revert contract: dropping the `wasActive &&` guard makes the "passive idle
 * preserves a synthesized denial" test go red.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
  cancelDoneGroupMove: vi.fn(() => false),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      expandToolResults: false,
      aiGeneratedTitles: false,
      autoGroupMovement: false,
      tabGroupMode: 'manual',
      doneGroupId: 'group-done',
      inProgressGroupId: 'group-inprogress',
      planningGroupId: 'group-planning',
    }),
  },
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import { seedMainPane, mainInstance } from './helpers/conversation-test-helpers'

const PLAN_DENIAL = {
  tools: [{ toolName: 'ExitPlanMode', toolUseId: 'restored', toolInput: { planFilePath: '/p/plan.md' } }],
}

function makeTab(status: string) {
  return {
    id: 'tab1',
    title: 'Conversation',
    engineProfileId: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    pillIcon: null,
    groupId: 'group-inprogress',
    groupPinned: false,
    status,
    customTitle: null,
    pillColor: null,
    permissionMode: 'plan' as const,
    queuedPrompts: [],
    historicalSessionIds: [],
    conversationId: 'conv-1',
    lastKnownSessionId: 'conv-1',
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: '',
    activeRequestId: null,
    currentActivity: '',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
  }
}

function buildHarness(tabStatus: string, permissionDenied: unknown) {
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [makeTab(tabStatus)],
    conversationPanes: seedMainPane('tab1', {
      permissionMode: 'plan',
      sessionModel: 'mock-model',
      permissionDenied: permissionDenied as any,
    }),
    backend: 'api',
    moveTabToGroup: vi.fn(),
    submit: vi.fn(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

describe('handleStatusChange — permissionDenied transition gate', () => {
  it('PRESERVES a synthesized denial on a passive idle→idle snapshot (the fix)', () => {
    const { state, slice } = buildHarness('idle', PLAN_DENIAL)
    // The recurring engine reconcile/heartbeat snapshot on a restored, already
    // idle tab. Must NOT wipe the plan-ready card's denial.
    slice.handleStatusChange!('tab1', 'idle', 'idle')
    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toEqual(PLAN_DENIAL)
  })

  it('PRESERVES a denial on a completed→idle tick (not a fresh run end)', () => {
    const { state, slice } = buildHarness('completed', PLAN_DENIAL)
    slice.handleStatusChange!('tab1', 'idle', 'completed')
    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toEqual(PLAN_DENIAL)
  })

  it('CLEARS a stale denial on a real run end (running→idle)', () => {
    const { state, slice } = buildHarness('running', PLAN_DENIAL)
    slice.handleStatusChange!('tab1', 'idle', 'running')
    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toBeNull()
  })

  it('CLEARS a stale denial on a connecting→idle transition (run settled)', () => {
    const { state, slice } = buildHarness('connecting', PLAN_DENIAL)
    slice.handleStatusChange!('tab1', 'idle', 'connecting')
    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toBeNull()
  })

  it('preserves the permissionQueue on a passive idle tick', () => {
    const { state, slice } = buildHarness('idle', PLAN_DENIAL)
    // A passive resync carries no run-lifecycle meaning. The queue can still
    // belong to an active restored interaction, so only a true transition may
    // clear it.
    const pane = state.conversationPanes.get('tab1')!
    pane.instances[0].permissionQueue = [{ questionId: 'q1', toolTitle: 'X', options: [] }]
    slice.handleStatusChange!('tab1', 'idle', 'idle')
    const inst = mainInstance(state.conversationPanes, 'tab1')
    expect(inst?.permissionQueue).toEqual([{ questionId: 'q1', toolTitle: 'X', options: [] }])
    expect(inst?.permissionDenied).toEqual(PLAN_DENIAL)
  })
})
