/**
 * Conversation-lifetime turn count on the drawer "Turns" row.
 *
 * REGRESSION: the drawer's "Turns" row rendered the per-run round-trip count
 * (TaskCompleteEvent.numTurns), so a long conversation whose last prompt took
 * two model round-trips showed "2" instead of the lifetime prompt count. The
 * engine now stamps StatusFields.conversationTurns (from
 * conversation.CountUserPrompts) onto the synthesized task_complete event; the
 * event-slice must persist it onto tab.lastResult.conversationTurns, which the
 * StatusDrawer renders in preference to numTurns.
 *
 * These tests go RED if the task_complete handler drops conversationTurns from
 * the lastResult mapping.
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
    tabs: [{ id: 'tab1', engineProfileId: 'test-profile', status: 'running', lastEventAt: 0, permissionDenied: null, contextTokens: 0, contextPercent: 0, permissionMode: 'auto', hasUnread: false, queuedPrompts: [], historicalSessionIds: [], activeRequestId: 'req-1', currentActivity: null, lastResult: null }],
    activeTabId: 'tab1',
    isExpanded: true,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
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

describe('event-slice task_complete — conversation-lifetime turns', () => {
  it('persists conversationTurns onto lastResult (distinct from per-run numTurns)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      result: '',
      costUsd: 0.5,
      durationMs: 1000,
      numTurns: 2, // per-run round-trips
      conversationTurns: 210, // lifetime prompt count
      usage: { input_tokens: 0, output_tokens: 0 },
      sessionId: 'conv-1',
      permissionDenials: [],
    } as any)

    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.lastResult).not.toBeNull()
    // The drawer prefers conversationTurns; it must be the lifetime value, not
    // the per-run count.
    expect(tab.lastResult.conversationTurns).toBe(210)
    // numTurns is preserved independently.
    expect(tab.lastResult.numTurns).toBe(2)
  })

  it('leaves conversationTurns undefined when the event omits it (CLI backend path)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      result: '',
      costUsd: 0.1,
      durationMs: 500,
      numTurns: 3,
      usage: { input_tokens: 0, output_tokens: 0 },
      sessionId: 'conv-2',
      permissionDenials: [],
    } as any)

    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.lastResult.conversationTurns).toBeUndefined()
    expect(tab.lastResult.numTurns).toBe(3)
  })
})
