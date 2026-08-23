/**
 * WI-001: permission denial handling via task_complete (normalized path)
 *
 * After the single-path collapse, permission denials from engine_status are
 * promoted to task_complete.permissionDenials in the normalized stream.
 * handleNormalizedEvent sets status='completed' and populates instance.permissionDenied
 * on the active instance for all conversation types (plain and extension-hosted).
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
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false, autoGroupMovement: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

function makeInstance(id: string) {
  return {
    id, label: id, messages: [], messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
    conversationIds: [], draftInput: '', agentStates: [],
    statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
  }
}

function buildHarness() {
  const state: any = {
    tabs: [{ id: 'tab1', engineProfileId: 'test-profile', status: 'running', lastEventAt: 0, permissionDenied: null, contextTokens: 0, contextPercent: 0, permissionMode: 'auto', hasUnread: false, queuedPrompts: [], historicalSessionIds: [], activeRequestId: null, currentActivity: null }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [makeInstance('main')], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

function getPermissionDenied(state: any, tabId: string) {
  return activeInstance(state.conversationPanes, tabId)?.permissionDenied
}

describe('task_complete with permissionDenials — pipeline convergence (WI-001)', () => {
  it('AskUserQuestion denial sets status=completed and populates instance.permissionDenied', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [
        { toolName: 'AskUserQuestion', toolUseId: 'ask-1', toolInput: { question: 'Pick one', options: ['A', 'B'] } },
      ],
    } as any)

    expect(state.tabs[0].status).toBe('completed')
    // The parent tab.permissionDenied is NOT written (per WI-001 sticky-parent invariant)
    expect(state.tabs[0].permissionDenied).toBeNull()
    const entry = getPermissionDenied(state, 'tab1')
    expect(entry).not.toBeNull()
    expect(entry!.tools).toHaveLength(1)
    expect(entry!.tools[0].toolName).toBe('AskUserQuestion')
    expect(entry!.tools[0].toolInput).toEqual({ question: 'Pick one', options: ['A', 'B'] })
  })

  it('ExitPlanMode denial sets status=completed and populates instance.permissionDenied', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [
        { toolName: 'ExitPlanMode', toolUseId: 'exit-1', toolInput: { planFilePath: '/tmp/plan.md' } },
      ],
    } as any)

    expect(state.tabs[0].status).toBe('completed')
    expect(state.tabs[0].permissionDenied).toBeNull()
    expect(getPermissionDenied(state, 'tab1')?.tools[0].toolName).toBe('ExitPlanMode')
  })

  it('task_complete without denials sets status=completed (normal path)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [],
    } as any)

    expect(state.tabs[0].status).toBe('completed')
    expect(state.tabs[0].permissionDenied).toBeNull()
  })

  it('task_complete records the stop time as completion and activity without marking it reviewed', () => {
    const { state, slice } = buildHarness()
    state.tabs[0].lastActivityAt = 1_000
    state.tabs[0].lastCompletionAt = null
    state.tabs[0].lastVisitedAt = 2_000
    state.isExpanded = true
    vi.useFakeTimers()
    vi.setSystemTime(new Date(3_000))

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [],
    } as any)

    expect(state.tabs[0]).toMatchObject({
      status: 'completed',
      lastActivityAt: 3_000,
      lastCompletionAt: 3_000,
      idleSince: 3_000,
      lastVisitedAt: 2_000,
    })
    vi.useRealTimers()
  })

  it('non-special denials (generic tool Write) ALSO set permissionDenied in the normalized path', () => {
    // WI-001 change: the normalized task_complete path does NOT filter by tool name.
    // Any denial in permissionDenials sets instance.permissionDenied. The old
    // handleEngineStatusEvent filtered non-interactive tools (Read, Bash, etc.) before
    // building the denial card; that filtering is not present in the normalized path
    // since the engine only emits interactive tool denials anyway.
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [
        { toolName: 'Write', toolUseId: 'w-1', toolInput: {} },
      ],
    } as any)

    expect(state.tabs[0].status).toBe('completed')
    // The engine normally only puts interactive tool denials here, but the normalized
    // path does NOT filter — the raw permission list is stored.
    const entry = getPermissionDenied(state, 'tab1')
    expect(entry).not.toBeNull()
    expect(entry!.tools[0].toolName).toBe('Write')
  })
})
