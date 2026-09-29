/**
 * assistant_turn_persisted — re-keying a delegated-CLI run's assistant rows.
 *
 * An engine-owned run mints each assistant entry id before it streams and
 * announces it on that message's message_end, so this reducer re-keys as it
 * goes. A delegated-CLI run cannot: Ion copies the turn into its store at run
 * exit, so at message_end time no entry exists and the event carries no
 * entryId. Those rows kept their local msg-N ids forever, and because iOS
 * builds its transcript from the engine's history page — canonical ids — the
 * tail fingerprint the two sides compare could never match. The client read
 * that as a permanent divergence and reloaded whole conversations on a loop.
 *
 * engine_assistant_turn_persisted closes the gap by naming the ids after the
 * write. The mapping is positional, so it is only applied when the counts
 * agree: ids that describe a transcript this process did not build would
 * otherwise assign a wrong identity to a row, which is worse than leaving it
 * local.
 */
import { describe, it, expect, vi } from 'vitest'

let seq = 0
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => `local-${seq++}`),
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

function buildHarness(initialMessages: any[]) {
  const state: any = {
    tabs: [{
      id: 'tab1', engineProfileId: 'test-profile', status: 'running', lastEventAt: 0,
      permissionMode: 'auto', permissionDenied: null, contextTokens: 0, contextPercent: 0,
      hasUnread: false, queuedPrompts: [], historicalSessionIds: [],
      activeRequestId: null, currentActivity: 'Writing...',
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [{
      id: 'main', label: 'main', messages: initialMessages,
      messageCount: initialMessages.length, modelOverride: null, sessionModel: null,
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
  return { state, slice: createEventSlice(set, get) as State }
}

/** A delegated-CLI run as this process builds it: local ids throughout. */
function cliRunRows() {
  return [
    { id: 'local-user', role: 'user', content: 'do the thing', timestamp: 1 },
    { id: 'msg-1', role: 'assistant', content: 'Let me check.', timestamp: 2 },
    { id: 'tool-row', role: 'tool', content: 'ok', toolName: 'Bash', toolId: 'toolu_1', toolStatus: 'completed', timestamp: 2 },
    { id: 'msg-2', role: 'assistant', content: 'Found it.', timestamp: 3 },
  ]
}

describe('assistant_turn_persisted', () => {
  it('re-keys the run assistant rows to the canonical entry ids', () => {
    const { state, slice } = buildHarness(cliRunRows())

    ;(slice as any).handleNormalizedEvent('tab1', {
      type: 'assistant_turn_persisted',
      entryIds: ['e1a2b3c4', 'e5f6a7b8'],
    })

    const msgs = activeInstance(state.conversationPanes, 'tab1')!.messages
    expect(msgs.map((m: any) => m.id)).toEqual([
      'local-user', 'e1a2b3c4', 'tool-row', 'e5f6a7b8',
    ])
    // Content is untouched: this is a re-key, never a transcript echo.
    expect(msgs.map((m: any) => m.content)).toEqual([
      'do the thing', 'Let me check.', 'ok', 'Found it.',
    ])
    // Re-keyed rows are closed; a later chunk must not append to them.
    expect(msgs[1].sealed).toBe(true)
    expect(msgs[3].sealed).toBe(true)
  })

  it('leaves every row alone when the counts disagree', () => {
    const { state, slice } = buildHarness(cliRunRows())

    ;(slice as any).handleNormalizedEvent('tab1', {
      type: 'assistant_turn_persisted',
      entryIds: ['only-one'],
    })

    const msgs = activeInstance(state.conversationPanes, 'tab1')!.messages
    expect(msgs.map((m: any) => m.id)).toEqual([
      'local-user', 'msg-1', 'tool-row', 'msg-2',
    ])
  })

  it('scopes the re-key to the current run, not earlier turns', () => {
    const { state, slice } = buildHarness([
      { id: 'old-e1', role: 'assistant', content: 'previous turn', timestamp: 1 },
      ...cliRunRows(),
    ])

    ;(slice as any).handleNormalizedEvent('tab1', {
      type: 'assistant_turn_persisted',
      entryIds: ['e1a2b3c4', 'e5f6a7b8'],
    })

    const msgs = activeInstance(state.conversationPanes, 'tab1')!.messages
    expect(msgs[0].id).toBe('old-e1')
    expect(msgs.map((m: any) => m.id)).toEqual([
      'old-e1', 'local-user', 'e1a2b3c4', 'tool-row', 'e5f6a7b8',
    ])
  })
})
