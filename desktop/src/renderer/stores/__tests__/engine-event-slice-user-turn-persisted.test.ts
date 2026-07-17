/**
 * user_turn_persisted — the run-outcome-independent optimistic-row re-key.
 *
 * The engine persists the run-opening user turn immediately at dispatch and
 * announces its canonical tree-entry id via engine_user_turn_persisted BEFORE
 * streaming. The reducer re-keys the most recent user row to that id so a run
 * that never reaches a message_end (cancel, mid-stream failure) still leaves
 * the optimistic row canonically keyed — otherwise the next history load
 * (rows keyed by canonical ids) cannot anchor on it and the user turn renders
 * twice. This is the regression test for the "duplicate user bubble after an
 * aborted image prompt" incident.
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

function buildHarness(messages: any[]) {
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
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [{
      id: 'main', label: 'main', messages,
      messageCount: messages.length, modelOverride: null, sessionModel: null,
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

describe('user_turn_persisted re-keys the optimistic user row', () => {
  it('re-keys the most recent user row to the canonical entry id', () => {
    const { state, slice } = buildHarness([
      { id: 'old-user', role: 'user', content: 'earlier turn', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'earlier reply', timestamp: 2, sealed: true },
      { id: 'client-msg-uuid', role: 'user', content: 'what is this image?', timestamp: 3 },
    ])

    slice.handleNormalizedEvent('tab1', {
      type: 'user_turn_persisted',
      entryId: 'entry-canonical-7',
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    const userRows = inst!.messages.filter((m: any) => m.role === 'user')
    // Only the MOST RECENT user row is re-keyed; earlier turns untouched.
    expect(userRows[userRows.length - 1].id).toBe('entry-canonical-7')
    expect(userRows[0].id).toBe('old-user')
  })

  it('is a no-op when the row already carries the canonical id', () => {
    const { state, slice } = buildHarness([
      { id: 'entry-canonical-7', role: 'user', content: 'hi', timestamp: 1 },
    ])

    slice.handleNormalizedEvent('tab1', {
      type: 'user_turn_persisted',
      entryId: 'entry-canonical-7',
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst!.messages[0].id).toBe('entry-canonical-7')
    expect(inst!.messages).toHaveLength(1)
  })

  it('does not disturb tab status (re-key is not a lifecycle event)', () => {
    const { state, slice } = buildHarness([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
    ])

    slice.handleNormalizedEvent('tab1', {
      type: 'user_turn_persisted',
      entryId: 'entry-x',
    } as any)

    expect(state.tabs[0].status).toBe('running')
  })
})
