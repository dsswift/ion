/**
 * WI-001: permission denials → instance.permissionDenied (normalized path)
 *
 * After the single-path collapse (WI-001), permission denials flow through
 * task_complete.permissionDenials (NormalizedEvent). handleNormalizedEvent
 * in event-slice.ts sets instance.permissionDenied on the active instance.
 *
 * The command_result /clear flow now goes through handleCrossNormalizedEvent
 * (engine-event-slice-messages.ts) via the normalized stream.
 *
 * Contract pinned here:
 *   1. AskUserQuestion / ExitPlanMode denials in task_complete populate
 *      the active instance's permissionDenied.
 *   2. Other denial tool names are ignored.
 *   3. The active instance's permissionDenied is cleared on command_result /clear
 *      via handleCrossNormalizedEvent.
 *   4. The parent tab.permissionDenied is NOT mutated.
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

// Keep handleCrossNormalizedEvent real so /clear tests work end-to-end.
// The clear divider format test uses engine-event-slice-messages.ts which
// calls formatClearDivider and commitInstance.
vi.mock('../slices/engine-event-slice-messages', async () => {
  const mod = await vi.importActual('../slices/engine-event-slice-messages')
  return { ...mod }
})

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
    tabs: [{ id: 'tab1', engineProfileId: 'test-profile', lastEventAt: 0, status: 'running', permissionDenied: null, contextTokens: 0, contextPercent: 0, permissionMode: 'auto', hasUnread: false, queuedPrompts: [], historicalSessionIds: [], activeRequestId: null, currentActivity: null }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    resources: {},
    resourceSubscriptions: new Map(),
    readResourceIds: new Set(),
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

describe('task_complete.permissionDenials → active instance.permissionDenied', () => {
  it('sets instance.permissionDenied for AskUserQuestion denial in task_complete', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [
        { toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'Pick one', options: ['A', 'B'] } },
      ],
    } as any)

    const entry = getPermissionDenied(state, 'tab1')
    expect(entry).not.toBeNull()
    expect(entry!.tools).toHaveLength(1)
    expect(entry!.tools[0].toolName).toBe('AskUserQuestion')
    expect(entry!.tools[0].toolUseId).toBe('tu-1')
    // Parent tab's permissionDenied stays null — instance-level only.
    expect(state.tabs[0].permissionDenied).toBeNull()
  })

  it('sets instance.permissionDenied for ExitPlanMode denial', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [
        { toolName: 'ExitPlanMode', toolUseId: 'tu-2', toolInput: { planFilePath: '/x/plan.md' } },
      ],
    } as any)

    expect(getPermissionDenied(state, 'tab1')?.tools[0].toolName).toBe('ExitPlanMode')
  })

  it('task_complete with non-interactive tool denials (Read, Bash) DOES set permissionDenied (no filtering in normalized path)', () => {
    // WI-001 change: the normalized path does NOT filter tool names.
    // The engine only emits interactive-tool denials in practice, so filtering
    // is not needed at the desktop layer.
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [
        { toolName: 'Read', toolUseId: 'tu-3', toolInput: { file_path: '/x' } },
        { toolName: 'Bash', toolUseId: 'tu-4', toolInput: { command: 'ls' } },
      ],
    } as any)

    // The normalized path does not filter: both denials are stored.
    expect(getPermissionDenied(state, 'tab1')).not.toBeNull()
    expect(getPermissionDenied(state, 'tab1')!.tools).toHaveLength(2)
  })

  it('task_complete without denials CLEARS existing permissionDenied (authoritative path)', () => {
    // WI-001 change: the normalized path is authoritative. task_complete with
    // an empty permissionDenials list always clears permissionDenied. This is
    // by design: a follow-up run that completes cleanly should clear any
    // leftover denial card from the previous run.
    const { state, slice } = buildHarness()

    // Tick 1: denial arrives.
    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [
        { toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'q?' } },
      ],
    } as any)
    expect(getPermissionDenied(state, 'tab1')).not.toBeNull()

    // Tick 2: follow-up task_complete with no denials clears the existing entry.
    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-2',
      costUsd: 0.001,
      durationMs: 1000,
      numTurns: 1,
      permissionDenials: [],
    } as any)

    expect(getPermissionDenied(state, 'tab1')).toBeNull()
  })
})
