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

  it('DOES set instance permissionMode to plan on planModeEnabled=true (WI-001: instance, not parent)', () => {
    const { state, slice } = buildHarness()
    state.tabs[0].permissionMode = 'auto'

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
    } as any)

    // WI-001: writes to the active INSTANCE, not the parent tab.
    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionMode).toBe('plan')
    // Parent tab.permissionMode stays unchanged (sticky-parent invariant).
    expect(state.tabs[0].permissionMode).toBe('auto')
  })

  it('does NOT append a divider on planModeEnabled=true (entry no longer draws the marker)', () => {
    // Plan-mode ENTRY happens before the model has written the plan file, so a
    // divider here would be mispositioned and its link would not resolve. The
    // divider is now driven by engine_plan_file_written (the actual write), not
    // by plan-mode entry. Entry still flips permissionMode + planFilePath.
    const { state, slice } = buildHarness()
    const messagesBefore = mainInstance(state.conversationPanes, 'tab1')!.messages.length

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_mode_changed' as any,
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)

    // No divider inserted on entry.
    expect(mainInstance(state.conversationPanes, 'tab1')!.messages.length).toBe(messagesBefore)
    // But state still updates: permissionMode → plan, planFilePath propagated.
    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionMode).toBe('plan')
    expect(mainInstance(state.conversationPanes, 'tab1')?.planFilePath).toBe('/tmp/plan.md')
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

describe('event-slice — engine_plan_file_written (divider trigger)', () => {
  it('appends a "Plan created" divider on operation=created, carrying planFilePath', () => {
    // The accurate divider trigger: the engine confirms a Write/Edit landed on
    // the plan file. operation="created" → "Plan created" marker. The divider
    // carries planFilePath so its slug is a clickable link to the plan preview.
    const { state, slice } = buildHarness()
    const messagesBefore = mainInstance(state.conversationPanes, 'tab1')!.messages.length

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_file_written' as any,
      planWriteOperation: 'created',
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

  it('appends a "Plan updated" divider on operation=updated, carrying planFilePath', () => {
    // operation="updated" → "Plan updated" marker. The engine carries the
    // discriminator (it observed the file already had content), so the client
    // trusts it rather than re-deriving from scrollback.
    const { state, slice } = buildHarness()
    const messagesBefore = mainInstance(state.conversationPanes, 'tab1')!.messages.length

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_file_written' as any,
      planWriteOperation: 'updated',
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)

    expect(mainInstance(state.conversationPanes, 'tab1')!.messages.length).toBe(messagesBefore + 1)
    const last = mainInstance(state.conversationPanes, 'tab1')!.messages.at(-1)!
    expect(last.content).toMatch(/^── Plan updated at /)
    expect(last.content).toContain('my-plan')
    expect(last.planFilePath).toBe('/tmp/plan.md')
  })

  it('defaults to "Plan created" when operation is missing or unknown', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_file_written' as any,
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)
    const last = mainInstance(state.conversationPanes, 'tab1')!.messages.at(-1)!
    expect(last.content).toMatch(/^── Plan created at /)
  })

  it('propagates planFilePath onto the instance when not already set', () => {
    const { state, slice } = buildHarness()
    const inst = mainInstance(state.conversationPanes, 'tab1')!
    inst.planFilePath = undefined as any

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_file_written' as any,
      planWriteOperation: 'created',
      planFilePath: '/tmp/new-plan.md',
      planSlug: 'new-plan',
    } as any)

    expect(mainInstance(state.conversationPanes, 'tab1')?.planFilePath).toBe('/tmp/new-plan.md')
  })
})

describe('event-slice — engine_plan_proposal as card trigger (Bug #2)', () => {
  it('synthesizes an ExitPlanMode permissionDenied when none is present', () => {
    // The proposal event is a first-class card trigger: even if task_complete
    // loses the control-plane race, the card must render from the proposal.
    const { state, slice } = buildHarness()
    const inst0 = mainInstance(state.conversationPanes, 'tab1')!
    inst0.permissionDenied = null

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_proposal' as any,
      planProposalKind: 'exit',
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)

    const denied = mainInstance(state.conversationPanes, 'tab1')!.permissionDenied
    expect(denied).not.toBeNull()
    expect(denied!.tools).toHaveLength(1)
    expect(denied!.tools[0].toolName).toBe('ExitPlanMode')
    expect(denied!.tools[0].toolInput?.planFilePath).toBe('/tmp/plan.md')
  })

  it('does NOT overwrite an existing permissionDenied (idempotent with task_complete)', () => {
    // If task_complete already set the denial, the proposal must not clobber it
    // — same card, not a duplicate or a replacement with a synthesized id.
    const { state, slice } = buildHarness()
    const inst0 = mainInstance(state.conversationPanes, 'tab1')!
    inst0.permissionDenied = {
      tools: [{ toolName: 'ExitPlanMode', toolUseId: 'real-engine-id', toolInput: { planFilePath: '/tmp/plan.md' } }],
    }

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_proposal' as any,
      planProposalKind: 'exit',
      planFilePath: '/tmp/plan.md',
    } as any)

    const denied = mainInstance(state.conversationPanes, 'tab1')!.permissionDenied
    expect(denied!.tools).toHaveLength(1)
    // The original engine id is preserved — the synthesized branch did not run.
    expect(denied!.tools[0].toolUseId).toBe('real-engine-id')
  })

  it('does NOT synthesize a denial for a non-exit proposal kind', () => {
    const { state, slice } = buildHarness()
    const inst0 = mainInstance(state.conversationPanes, 'tab1')!
    inst0.permissionDenied = null

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_proposal' as any,
      planProposalKind: 'something_else',
      planFilePath: '/tmp/plan.md',
    } as any)

    expect(mainInstance(state.conversationPanes, 'tab1')!.permissionDenied).toBeNull()
  })
})

describe('event-slice — engine_plan_proposal recovers instance plan mode (Bug #1 Layer 2)', () => {
  it('sets instance permissionMode to plan when the entry event was dropped (mode was auto)', () => {
    // Simulate the dropped-entry-event scenario: the instance is still at the
    // 'auto' creation default because engine_plan_mode_changed{enabled:true}
    // never reached the renderer. A kind="exit" proposal must recover plan mode.
    const { state, slice } = buildHarness()
    const inst0 = mainInstance(state.conversationPanes, 'tab1')!
    inst0.permissionMode = 'auto'
    inst0.permissionDenied = null

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_proposal' as any,
      planProposalKind: 'exit',
      planFilePath: '/tmp/plan.md',
    } as any)

    expect(mainInstance(state.conversationPanes, 'tab1')!.permissionMode).toBe('plan')
  })

  it('does NOT flip an instance that is already plan (no redundant write needed) and never flips to auto', () => {
    const { state, slice } = buildHarness()
    const inst0 = mainInstance(state.conversationPanes, 'tab1')!
    inst0.permissionMode = 'plan'
    inst0.permissionDenied = null

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_proposal' as any,
      planProposalKind: 'exit',
      planFilePath: '/tmp/plan.md',
    } as any)

    // Stays plan — a proposal NEVER flips to auto (that is onImplement's job).
    expect(mainInstance(state.conversationPanes, 'tab1')!.permissionMode).toBe('plan')
  })

  it('does NOT recover mode for a non-exit proposal kind', () => {
    const { state, slice } = buildHarness()
    const inst0 = mainInstance(state.conversationPanes, 'tab1')!
    inst0.permissionMode = 'auto'

    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_proposal' as any,
      planProposalKind: 'something_else',
      planFilePath: '/tmp/plan.md',
    } as any)

    expect(mainInstance(state.conversationPanes, 'tab1')!.permissionMode).toBe('auto')
  })
})

describe('event-slice — task_complete with ExitPlanMode denial', () => {
  it('populates permissionDenied and does NOT schedule submit while in plan mode', () => {
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
    expect(state.submit).not.toHaveBeenCalled()
  })
})
