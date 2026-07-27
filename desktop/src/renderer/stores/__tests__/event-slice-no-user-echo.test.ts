/**
 * Regression: the engine does not echo user turns back to clients, so the
 * renderer never synthesizes a user bubble from a live engine event stream.
 *
 * Root cause this pins (conversation 1782596686130-e4df0482fa34): an extension
 * injected a turn via ctx.sendMessage. The engine used to echo every appended
 * user turn as engine_user_turn, which the renderer rendered as a live user
 * bubble — surfacing the extension-injected "Context Preserved Across
 * Compaction" summary as a phantom user message the user never typed.
 *
 * The fix removed engine_user_turn end to end. These tests pin that:
 *   1. A live run that streams ONLY assistant text (the shape an
 *      extension-injected turn produces from the local client's view — no
 *      optimistic insert, no user echo) never produces a user-role message.
 *   2. The retired `user_turn` reducer arm is gone: feeding the legacy event
 *      shape inserts NOTHING (no phantom bubble), proving the dedup-laden
 *      handler was fully removed rather than left as a latent insert path.
 *
 * The reducer is exercised at its public seam (handleNormalizedEvent), the same
 * stable boundary the rest of the event-slice suite uses.
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
    tabs: [{
      id: 'tab1', engineProfileId: 'test-profile', status: 'running', lastEventAt: 0,
      permissionMode: 'auto', permissionDenied: null, contextTokens: 0, contextPercent: 0,
      hasUnread: false, queuedPrompts: [], historicalSessionIds: [], activeRequestId: null,
      currentActivity: null,
    }],
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

function activeMessages(state: any) {
  return state.conversationPanes.get('tab1').instances[0].messages
}

describe('no engine echo of user turns (phantom-bubble regression)', () => {
  it('an assistant-only live stream never synthesizes a user bubble', () => {
    const { state, slice } = buildHarness()

    // An extension-injected turn (ctx.sendMessage) produces, from the local
    // client's perspective, a run that streams assistant output with NO
    // optimistic user insert and NO user echo. The reducer must not invent a
    // user-role message from any of these events.
    slice.handleNormalizedEvent('tab1', { type: 'text_chunk', text: 'Context preserved.' } as any)
    slice.handleNormalizedEvent('tab1', { type: 'text_chunk', text: ' Done.' } as any)
    slice.handleNormalizedEvent('tab1', { type: 'task_complete', result: 'ok' } as any)

    const msgs = activeMessages(state)
    expect(msgs.some((m: any) => m.role === 'user')).toBe(false)
    // The assistant text still renders — only the phantom user bubble is gone.
    expect(msgs.some((m: any) => m.role === 'assistant')).toBe(true)
  })

  it('the retired user_turn event inserts nothing (handler fully removed)', () => {
    const { state, slice } = buildHarness()

    // The legacy engine_user_turn → user_turn reducer arm was deleted. Feeding
    // the old event shape must be an inert no-op: no user bubble, no throw. If a
    // future change reintroduces an insert path, this fails.
    slice.handleNormalizedEvent('tab1', {
      type: 'user_turn',
      id: 'entry-123',
      content: 'This summary was injected by the session_compact hook.',
      timestamp: 1700000000123,
    } as any)

    const msgs = activeMessages(state)
    expect(msgs).toHaveLength(0)
  })
})
