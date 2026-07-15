/**
 * harness_message — WI-001 dedup convention (normalized stream)
 *
 * After the single-path collapse (WI-001), engine_harness_message is promoted
 * to a NormalizedEvent variant (harness_message) and handled by handleNormalizedEvent
 * in event-slice.ts. The dedupKey logic is preserved: if a message with the same
 * dedupKey already exists in the active instance's scrollback, the duplicate is
 * suppressed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: (() => {
    let n = 0
    return vi.fn(() => `mock-msg-${++n}`)
  })(),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false })) },
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
    tabs: [{ id: 'tab1', engineProfileId: 'test-profile', lastEventAt: 0, hasUnread: false, queuedPrompts: [], historicalSessionIds: [] }],
    activeTabId: 'tab1',
    isExpanded: false,
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

function getMessages(state: any) {
  return activeInstance(state.conversationPanes, 'tab1')?.messages ?? []
}

describe('harness_message dedupKey convention (WI-001 normalized path)', () => {
  it('drops the second emission when dedupKey matches a prior harness message', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Welcome to Ion Meta',
      dedupKey: 'ion-meta:welcome',
      source: 'ion-meta',
    } as any)

    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Welcome to Ion Meta',
      dedupKey: 'ion-meta:welcome',
      source: 'ion-meta',
    } as any)

    const msgs = getMessages(state)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('harness')
    expect(msgs[0].content).toBe('Welcome to Ion Meta')
    expect((msgs[0] as any).dedupKey).toBe('ion-meta:welcome')
  })

  it('pushes both emissions when dedupKey values differ', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', { type: 'harness_message', message: 'first', dedupKey: 'ext:msg-a' } as any)
    slice.handleNormalizedEvent('tab1', { type: 'harness_message', message: 'second', dedupKey: 'ext:msg-b' } as any)

    const msgs = getMessages(state)
    expect(msgs).toHaveLength(2)
    expect((msgs[0] as any).dedupKey).toBe('ext:msg-a')
    expect((msgs[1] as any).dedupKey).toBe('ext:msg-b')
  })

  it('pushes both emissions when dedupKey is absent (opt-out)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', { type: 'harness_message', message: 'bare 1' } as any)
    slice.handleNormalizedEvent('tab1', { type: 'harness_message', message: 'bare 2' } as any)

    const msgs = getMessages(state)
    expect(msgs).toHaveLength(2)
    expect((msgs[0] as any).dedupKey).toBeUndefined()
    expect((msgs[1] as any).dedupKey).toBeUndefined()
  })

  it('suppresses duplicate after persist/restore: dedupKey survives serialization round-trip', () => {
    // Regression for the harnessDedup vs dedupKey mismatch that caused dedup to
    // fail after restart. The serializer (serialize-conversation-pane.ts:185) and
    // restore (useTabRestoration-engine.ts:457) both use `dedupKey`; this test
    // simulates what restore produces — a scrollback message carrying `dedupKey` —
    // and confirms the event handler recognizes and suppresses a subsequent duplicate.
    const { state, slice } = buildHarness()

    // Simulate a restored scrollback: inject a harness message that carries
    // `dedupKey` as it would arrive after serialize → persist → restore.
    const restoredPane = state.conversationPanes.get('tab1')
    restoredPane.instances[0].messages = [
      {
        id: 'restored-msg-1',
        role: 'harness',
        content: 'Welcome to Ion Meta',
        timestamp: 1000,
        dedupKey: 'ion-meta:welcome',
      },
    ]

    // Fire a second harness_message emission (what the engine sends on reconnect).
    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Welcome to Ion Meta',
      dedupKey: 'ion-meta:welcome',
      source: 'ion-meta',
    } as any)

    // Duplicate must be suppressed — count stays at 1.
    const msgs = getMessages(state)
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as any).dedupKey).toBe('ion-meta:welcome')
  })
})

describe('harness_message relocate dedup mode', () => {
  it('two relocate-keyed events → exactly one marker at the end', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Session bootstrapped: ion-meta v1',
      dedupKey: 'ion-meta:bootstrap',
      dedupMode: 'relocate',
      source: 'ion-meta',
    } as any)

    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Session bootstrapped: ion-meta v1',
      dedupKey: 'ion-meta:bootstrap',
      dedupMode: 'relocate',
      source: 'ion-meta',
    } as any)

    const msgs = getMessages(state)
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as any).dedupKey).toBe('ion-meta:bootstrap')
  })

  it('marker relocates past intervening non-bootstrap messages on third emission', () => {
    const { state, slice } = buildHarness()

    // First bootstrap marker
    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Session bootstrapped: ion-meta v1',
      dedupKey: 'ion-meta:bootstrap',
      dedupMode: 'relocate',
      source: 'ion-meta',
    } as any)

    // Intervening assistant message
    slice.handleNormalizedEvent('tab1', {
      type: 'message_start',
    } as any)

    // Inject a non-harness message directly into scrollback to simulate conversation
    const pane = state.conversationPanes.get('tab1')
    pane.instances[0].messages.push({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Hello from assistant',
      timestamp: Date.now(),
    } as any)

    // Second bootstrap emission (engine restart)
    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Session bootstrapped: ion-meta v1',
      dedupKey: 'ion-meta:bootstrap',
      dedupMode: 'relocate',
      source: 'ion-meta',
    } as any)

    const msgs = getMessages(state)
    // Still exactly one bootstrap marker — relocated to end, past assistant msg
    const bootstrapMsgs = msgs.filter((m) => (m as any).dedupKey === 'ion-meta:bootstrap')
    expect(bootstrapMsgs).toHaveLength(1)
    // Marker must be the last message
    expect((msgs[msgs.length - 1] as any).dedupKey).toBe('ion-meta:bootstrap')
  })

  it('default suppress-later path unchanged when dedupMode absent', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Welcome to Ion Meta',
      dedupKey: 'ion-meta:welcome',
      source: 'ion-meta',
    } as any)

    slice.handleNormalizedEvent('tab1', {
      type: 'harness_message',
      message: 'Welcome to Ion Meta',
      dedupKey: 'ion-meta:welcome',
      source: 'ion-meta',
    } as any)

    const msgs = getMessages(state)
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as any).dedupKey).toBe('ion-meta:welcome')
  })
})
