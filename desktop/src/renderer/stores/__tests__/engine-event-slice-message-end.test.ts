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
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false, autoGroupMovement: false })) },
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
