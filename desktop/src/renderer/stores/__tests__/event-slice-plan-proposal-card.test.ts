/**
 * event-slice — plan proposal card survives an empty task_complete.
 *
 * Regression for the codex/grok-ACP plan flow: those backends capture the
 * plan via a native plan item and emit engine_plan_proposal (which the
 * plan-mode reducer synthesizes into permissionDenied), but — unlike
 * claude-code — they do NOT put an ExitPlanMode denial on the follow-up
 * task_complete. The task_complete "no denials" branch used to null
 * permissionDenied unconditionally, wiping the just-synthesized approval card:
 * the user saw a clickable plan marker with content but no approve/implement
 * card. This test pins that a pending ExitPlanMode plan proposal survives an
 * empty task_complete.
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
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [makeTab()],
    conversationPanes: seedMainPane('tab1', {
      permissionMode: 'plan',
      sessionModel: 'codex',
      planFilePath: '/tmp/plan.md',
    }),
    backend: 'hybrid',
    engineModelFallbacks: new Map(),
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

describe('event-slice — plan proposal card survives empty task_complete', () => {
  it('preserves a synthesized ExitPlanMode proposal when task_complete has no denials (codex/grok path)', () => {
    const { state, slice } = buildHarness()

    // 1. The engine captured the native plan and emitted a proposal. The
    //    plan-mode reducer synthesizes the ExitPlanMode approval card.
    slice.handleNormalizedEvent!('tab1', {
      type: 'engine_plan_proposal' as any,
      planProposalKind: 'exit',
      planFilePath: '/tmp/plan.md',
      planSlug: 'plan',
    } as any)

    const afterProposal = mainInstance(state.conversationPanes, 'tab1')
    expect(afterProposal?.permissionDenied?.tools?.[0]?.toolName).toBe('ExitPlanMode')

    // 2. task_complete arrives with NO denials (codex does not re-supply the
    //    ExitPlanMode denial the way claude-code does).
    slice.handleNormalizedEvent!('tab1', {
      type: 'task_complete',
      sessionId: 'conv-1',
      costUsd: 0,
      durationMs: 1000,
      numTurns: 1,
      permissionDenials: [],
    } as any)

    // The card must survive — the pending plan proposal is not something
    // task_complete owns or clears.
    const afterComplete = mainInstance(state.conversationPanes, 'tab1')
    expect(afterComplete?.permissionDenied?.tools?.[0]?.toolName).toBe('ExitPlanMode')
  })

  it('still clears a non-plan permissionDenied on an empty task_complete', () => {
    const { state, slice } = buildHarness()

    // Seed a non-plan denial (e.g. a normal tool approval left pending).
    const pane = state.conversationPanes.get('tab1')
    pane.instances[0].permissionDenied = { tools: [{ toolName: 'Bash', toolUseId: 'x', toolInput: {} }] }

    slice.handleNormalizedEvent!('tab1', {
      type: 'task_complete',
      sessionId: 'conv-1',
      costUsd: 0,
      durationMs: 1000,
      numTurns: 1,
      permissionDenials: [],
    } as any)

    // A non-plan denial is still cleared — only pending plan proposals are
    // preserved.
    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toBeNull()
  })
})
