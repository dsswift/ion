/**
 * message_end — WI-001 normalized path does NOT idle the tab
 *
 * Regression pin for the "flickering Interrupt button between tool calls" fix.
 * After WI-001, engine_message_end is promoted to the normalized variant
 * `message_end` handled by handleNormalizedEvent in event-slice.ts.
 *
 * The authoritative idle signal is task_complete (from engine_status { state: "idle" }).
 * message_end seals the current assistant row and updates usage but must NOT flip
 * tab.status to anything other than 'running'.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn((u: any) => u?.input_tokens ?? 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

function buildHarness() {
  const state: any = {
    tabs: [{
      id: 'tab1',
      engineProfileId: 'test-profile',
      status: 'running',
      lastEventAt: 0,
      permissionMode: 'auto',
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
      hasUnread: false,
      queuedPrompts: [],
      historicalSessionIds: [],
      activeRequestId: null,
      currentActivity: 'Writing...',
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [{
      id: 'main', label: 'main', messages: [
        { id: 'a', role: 'assistant', content: 'partial text', timestamp: 1, sealed: false },
      ],
      messageCount: 1, modelOverride: null, sessionModel: null,
      permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
      conversationIds: [], draftInput: '', agentStates: [],
      statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
    }], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

describe('message_end (normalized) does not flip tab to idle', () => {
  it('leaves status=running after a mid-run message_end', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'message_end',
      inputTokens: 1234,
      contextPercent: 12.5,
      cost: 0.0042,
    } as any)

    // Status must remain 'running'.
    expect(state.tabs[0].status).toBe('running')
  })

  it('seals the last assistant message so the next text_chunk starts fresh', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'message_end',
      inputTokens: 100,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    const lastMsg = inst?.messages[inst.messages.length - 1]
    expect(lastMsg?.sealed).toBe(true)
  })

  it('only transitions to completed on explicit task_complete', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'message_end',
      inputTokens: 100,
      contextPercent: 1,
      cost: 0.001,
    } as any)
    expect(state.tabs[0].status).toBe('running')

    // Engine reports true run-exit via task_complete.
    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0.001,
      durationMs: 1000,
      numTurns: 1,
      permissionDenials: [],
    } as any)
    expect(state.tabs[0].status).toBe('completed')
  })

  it('handles message_end without usage payload — status untouched', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', { type: 'message_end' } as any)

    expect(state.tabs[0].status).toBe('running')
    expect(state.tabs[0].contextTokens).toBe(0)
  })
})

/**
 * A message_end names the run-opening user turn's canonical id. After a steer
 * the most recent user row is the steer, not the opening turn, and re-keying
 * it gave two rows the same id -- a transcript no client can key a list by.
 */
describe('message_end user re-key after a steer', () => {
  it('leaves every row with its own id when the opening turn is already canonical', () => {
    const { state, slice } = buildHarness()
    const pane = state.conversationPanes.get('tab1')
    pane.instances[0].messages = [
      { id: 'u1', role: 'user', content: 'open', timestamp: 1 },
      { id: 'e1', role: 'assistant', content: 'first', timestamp: 2, sealed: true },
      { id: 'e-steer', role: 'user', content: 'steer', timestamp: 3, steerApplied: true },
      { id: 'local', role: 'assistant', content: 'second', timestamp: 4 },
    ]

    slice.handleNormalizedEvent('tab1', { type: 'message_end', entryId: 'e2', userEntryId: 'u1' } as any)

    const ids = activeInstance(state.conversationPanes, 'tab1')!.messages.map((m: any) => m.id)
    expect(ids).toEqual(['u1', 'e1', 'e-steer', 'e2'])
  })

  it('still re-keys the opening turn when nothing carries its id yet', () => {
    const { state, slice } = buildHarness()
    state.conversationPanes.get('tab1').instances[0].messages = [
      { id: 'local-user', role: 'user', content: 'open', timestamp: 1 },
      { id: 'local', role: 'assistant', content: 'reply', timestamp: 2 },
    ]
    slice.handleNormalizedEvent('tab1', { type: 'message_end', entryId: 'e1', userEntryId: 'u1' } as any)
    expect(activeInstance(state.conversationPanes, 'tab1')!.messages.map((m: any) => m.id)).toEqual(['u1', 'e1'])
  })
})

describe('user_turn_persisted after a steer', () => {
  it('does not move the opening id onto a later user row', () => {
    const { state, slice } = buildHarness()
    state.conversationPanes.get('tab1').instances[0].messages = [
      { id: 'u1', role: 'user', content: 'open', timestamp: 1 },
      { id: 'phone-2', role: 'user', content: 'steer', timestamp: 2, steerPending: true },
    ]
    slice.handleNormalizedEvent('tab1', { type: 'user_turn_persisted', entryId: 'u1' } as any)
    expect(activeInstance(state.conversationPanes, 'tab1')!.messages.map((m: any) => m.id)).toEqual(['u1', 'phone-2'])
  })
})
