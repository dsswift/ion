/**
 * event-slice — plan-mode handling
 *
 * Pins two contracts that flow from the F3 fix in
 * /Users/josh/.claude/plans/i-need-you-to-jazzy-summit.md:
 *
 *   1. `engine_plan_mode_changed { planModeEnabled: false }` must NOT
 *      mutate `permissionMode`. The model calling ExitPlanMode is a
 *      proposal, not a confirmed transition; the user-approval gate in
 *      onImplement is the sole chokepoint for flipping to 'auto'.
 *   2. `task_complete` carrying an `ExitPlanMode` permission denial
 *      while still in plan mode must populate `permissionDenied` and
 *      must NOT schedule a synthetic "Plan mode is not active..." user
 *      message (the prior race-compensator is gone).
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
      doneGroupId: null,
      inProgressGroupId: null,
    }),
  },
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import { seedMainPane, mainInstance } from './helpers/conversation-test-helpers'

function makeTab() {
  return {
    id: 'tab1',
    title: 'Engine',
    hasEngineExtension: false,
    engineProfileId: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    pillIcon: null,
    groupId: null,
    groupPinned: false,
    status: 'running' as const,
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
    activeRequestId: 'req-1',
    currentActivity: 'Planning...',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
  }
}

function buildHarness() {
  // Per-conversation state (messages, permissionDenied, sessionModel,
  // planFilePath) lives on the tab's `main` instance now; seed it eagerly so
  // the event-slice reducer resolves the active instance.
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [makeTab()],
    conversationPanes: seedMainPane('tab1', {
      permissionMode: 'plan',
      sessionModel: 'mock-model',
      planFilePath: '/tmp/plan.md',
    }),
    backend: 'api',
    sendMessage: vi.fn(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

describe('event-slice — engine_plan_mode_changed', () => {
  it('does NOT mutate permissionMode on planModeEnabled=false', () => {
    const { state, slice } = buildHarness()
    expect(state.tabs[0].permissionMode).toBe('plan')

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: false,
      planFilePath: '/tmp/plan.md',
    } as any)

    // The mode flip back to 'auto' must wait for the user-approval gate
    // in onImplement. The engine event is advisory only.
    expect(state.tabs[0].permissionMode).toBe('plan')
    // planFilePath is still propagated (on the instance) so the approval
    // card has the path.
    expect(mainInstance(state.conversationPanes, 'tab1')?.planFilePath).toBe('/tmp/plan.md')
  })

  it('DOES set permissionMode to plan on planModeEnabled=true', () => {
    const { state, slice } = buildHarness()
    state.tabs[0].permissionMode = 'auto'

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
    } as any)

    expect(state.tabs[0].permissionMode).toBe('plan')
  })

  it('appends a "Plan created" divider system message on planModeEnabled=true', () => {
    // Regression test: the event-slice handler also seeds a divider into
    // the CLI tab's `main` instance messages so the user can see when the
    // plan phase started. The earlier test only verified permissionMode;
    // this one pins the divider-insertion path that engine-event-slice.ts
    // mirrors for the engine-tab path.
    const { state, slice } = buildHarness()
    const messagesBefore = mainInstance(state.conversationPanes, 'tab1')!.messages.length

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)

    expect(mainInstance(state.conversationPanes, 'tab1')!.messages.length).toBe(messagesBefore + 1)
    const last = mainInstance(state.conversationPanes, 'tab1')!.messages.at(-1)!
    expect(last.role).toBe('system')
    expect(last.content).toMatch(/^── Plan created at /)
    expect(last.content).toContain('my-plan')
    expect(last.planFilePath).toBe('/tmp/plan.md')
  })

  it('does NOT append a divider on planModeEnabled=false', () => {
    // The false branch is a proposal (ExitPlanMode) — the desktop's
    // user-approval gate is the authoritative chokepoint, so the
    // proposal must not insert a divider into the scrollback.
    const { state, slice } = buildHarness()
    const messagesBefore = mainInstance(state.conversationPanes, 'tab1')!.messages.length

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: false,
      planFilePath: '/tmp/plan.md',
    } as any)

    expect(mainInstance(state.conversationPanes, 'tab1')!.messages.length).toBe(messagesBefore)
  })
})

describe('event-slice — task_complete with ExitPlanMode denial', () => {
  it('populates permissionDenied and does NOT schedule sendMessage while in plan mode', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent!('tab1', {
      type: 'task_complete',
      result: '',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
      sessionId: 'conv-1',
      permissionDenials: [
        {
          toolName: 'ExitPlanMode',
          toolUseID: 'exit-1',
          toolInput: { planFilePath: '/tmp/plan.md' },
        },
      ],
    } as any)

    const denied = mainInstance(state.conversationPanes, 'tab1')!.permissionDenied
    expect(denied).not.toBeNull()
    expect(denied!.tools).toHaveLength(1)
    expect(denied!.tools[0].toolName).toBe('ExitPlanMode')

    // Confirm no synthetic "Plan mode is not active..." message was scheduled.
    expect(state.sendMessage).not.toHaveBeenCalled()
  })
})
