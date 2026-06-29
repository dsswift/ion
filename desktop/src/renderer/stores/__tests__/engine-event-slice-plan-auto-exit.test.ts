/**
 * Regression: plan_mode_auto_exit must clear the active INSTANCE permissionMode
 * to 'auto' without touching the parent tab.permissionMode (sticky-parent invariant).
 *
 * After WI-001 (single-path collapse), this event flows through handleNormalizedEvent
 * (event-slice.ts) instead of handleEngineEvent. The sticky-parent invariant is
 * preserved by writing only instPatch.permissionMode, never updated.permissionMode.
 *
 * Revert-test contract: removing the `plan_mode_auto_exit` case from event-slice.ts
 * causes the "parent stays unwritten" tests to fail because permissionMode would
 * remain 'plan' on the instance or be written to the parent.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

function makeInstance(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    messages: [] as any[],
    messageCount: 0,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'plan' as const,
    permissionDenied: null,
    permissionQueue: [],
    elicitationQueue: [],
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    thinkingEffort: 'off' as const,
    sealed: false,
    ...overrides,
  }
}

function buildHarness(instanceOverrides: Record<string, unknown> = {}) {
  const state: any = {
    tabs: [{
      id: 'tab1',
      engineProfileId: 'test-profile',
      status: 'running',
      lastEventAt: 0,
      permissionMode: undefined,   // parent tab: deliberately NOT set (ghost field)
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
      hasUnread: false,
      queuedPrompts: [],
      historicalSessionIds: [],
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', {
      instances: [makeInstance('main', instanceOverrides)],
      activeInstanceId: 'main',
    }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

// ─── Defect 1: plan_mode_auto_exit clears instance permissionMode ──────────

describe('Defect 1 — plan_mode_auto_exit clears instance permissionMode to auto', () => {
  it('sets instance permissionMode to auto when auto_exit fires', () => {
    const { state, slice } = buildHarness({ permissionMode: 'plan' })

    const instBefore = activeInstance(state.conversationPanes, 'tab1')
    expect(instBefore?.permissionMode).toBe('plan')

    slice.handleNormalizedEvent('tab1', {
      type: 'plan_mode_auto_exit',
      stopReason: 'end_turn',
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)

    const instAfter = activeInstance(state.conversationPanes, 'tab1')
    expect(instAfter?.permissionMode).toBe('auto')
  })

  it('is a no-op when tab does not exist (no crash)', () => {
    const { slice } = buildHarness()
    expect(() => {
      slice.handleNormalizedEvent('nonexistent-tab', {
        type: 'plan_mode_auto_exit',
        stopReason: 'end_turn',
      } as any)
    }).not.toThrow()
  })

  it('permissionMode stays auto after auto_exit fires twice (idempotent)', () => {
    const { state, slice } = buildHarness({ permissionMode: 'plan' })

    slice.handleNormalizedEvent('tab1', { type: 'plan_mode_auto_exit', stopReason: 'end_turn' } as any)
    slice.handleNormalizedEvent('tab1', { type: 'plan_mode_auto_exit', stopReason: 'end_turn' } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.permissionMode).toBe('auto')
  })

  // Sticky-parent invariant: plan_mode_auto_exit writes ONLY the active instance's
  // permissionMode. The parent tab.permissionMode must NEVER be written — doing so
  // would leave it permanently 'plan' across instance switches and break the
  // done-group move for auto-mode runs.
  it('does NOT touch the parent tab.permissionMode (sticky-parent invariant)', () => {
    const { state, slice } = buildHarness({ permissionMode: 'plan' })
    const parentPermModeBefore = state.tabs[0].permissionMode

    slice.handleNormalizedEvent('tab1', { type: 'plan_mode_auto_exit', stopReason: 'end_turn' } as any)

    // Instance permissionMode must be cleared.
    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.permissionMode).toBe('auto')
    // Parent tab.permissionMode must be UNCHANGED (the ghost field invariant).
    expect(state.tabs[0].permissionMode).toBe(parentPermModeBefore)
  })

  // Revert-test: if we remove `instPatch.permissionMode = 'auto'` from event-slice.ts,
  // this test turns red (instance still has 'plan'). The test name documents the
  // deliberate fragility so future refactors know this is a load-bearing assertion.
  it('REVERT-TEST: if the auto_exit case is removed from event-slice.ts, this fails', () => {
    // This test is structurally identical to the first — it exists only to document
    // the regression contract and surface clearly in test output when reverted.
    const { state, slice } = buildHarness({ permissionMode: 'plan' })

    slice.handleNormalizedEvent('tab1', { type: 'plan_mode_auto_exit', stopReason: 'end_turn' } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    // If the case is removed, permissionMode remains 'plan' and this fails.
    expect(inst?.permissionMode).toBe('auto')
    // And the parent must still be unwritten.
    expect(state.tabs[0].permissionMode).toBeUndefined()
  })
})

// ─── Defect 2: engine_plan_mode_changed writes instance.planFilePath ────────

describe('Defect 2 — engine_plan_mode_changed (normalized path)', () => {
  it('writes planFilePath to the instance on plan_mode_changed', () => {
    const { state, slice } = buildHarness({ permissionMode: 'auto', planFilePath: null })

    slice.handleNormalizedEvent('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.planFilePath).toBe('/tmp/plan.md')
  })

  it('WI-001: writes permissionMode to the INSTANCE (not parent tab) on plan_mode_changed', () => {
    const { state, slice } = buildHarness({ permissionMode: 'auto' })

    slice.handleNormalizedEvent('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    // Instance gets 'plan'.
    expect(inst?.permissionMode).toBe('plan')
    // Parent tab.permissionMode is NOT written (undefined, ghost).
    expect(state.tabs[0].permissionMode).toBeUndefined()
  })

  it('inserts a divider message when engine_plan_file_written fires (the write)', () => {
    const { state, slice } = buildHarness({ permissionMode: 'auto', messages: [] })

    // Plan-mode entry alone no longer draws a divider; the actual plan-file
    // write does. Fire entry first (state only), then the write (divider).
    slice.handleNormalizedEvent('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)
    expect(activeInstance(state.conversationPanes, 'tab1')?.messages.length).toBe(0)

    slice.handleNormalizedEvent('tab1', {
      type: 'engine_plan_file_written' as any,
      planWriteOperation: 'created',
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    // A "Plan created" divider must be inserted.
    expect(inst?.messages.length).toBe(1)
    expect(inst?.messages[0].role).toBe('system')
  })
})
