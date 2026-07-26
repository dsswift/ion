/**
 * engine-event-slice — thinking events flow through handleNormalizedEvent (WI-001)
 *
 * After the single-path collapse (WI-001), thinking events flow through
 * handleNormalizedEvent exclusively. handleEngineEvent has been retired.
 *
 * These tests verify the WI-001 contract:
 *   - thinking_block_start / thinking_delta / thinking_block_end are handled
 *     by handleNormalizedEvent (via event-slice-thinking.ts)
 *   - stream_reset discards in-progress thinking rows
 *   - text_chunk writes assistant messages
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn().mockImplementation(() => `id-${Math.random()}`),
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

function buildHarness() {
  const state: any = {
    tabs: [{
      id: 'tab1',
      engineProfileId: 'test-profile',
      status: 'running',
      lastEventAt: 0,
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
      hasUnread: false,
      queuedPrompts: [],
      historicalSessionIds: [],
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', {
      instances: [{
        id: 'main', label: 'main', messages: [], messageCount: 0, modelOverride: null,
        sessionModel: null, permissionMode: 'auto', permissionDenied: null,
        permissionQueue: [], elicitationQueue: [], conversationIds: [], draftInput: '', agentStates: [],
        statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
      }],
      activeInstanceId: 'main',
    }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

function messages(state: any) {
  return activeInstance(state.conversationPanes, 'tab1')?.messages ?? []
}

describe('WI-001 — thinking events handled by handleNormalizedEvent', () => {
  it('thinking_block_start opens a thinking row in instance messages', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', { type: 'thinking_block_start' } as any)

    // A thinking row should be opened (handled by event-slice-thinking.ts)
    // The exact structure is tested in event-slice-thinking.test.ts;
    // here we just confirm it's not a no-op.
    const msgs = messages(state)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
  })

  it('text_chunk writes assistant message via handleNormalizedEvent (not handleEngineEvent)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', { type: 'text_chunk', text: 'hello world' } as any)

    const msgs = messages(state)
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].content).toBe('hello world')
  })

  it('stream_reset discards trailing assistant text via handleNormalizedEvent', () => {
    const { state, slice } = buildHarness()
    // Seed an in-progress assistant message
    state.conversationPanes.get('tab1').instances[0].messages = [
      { id: 'a', role: 'assistant', content: 'partial...', sealed: false, timestamp: 1 },
    ]

    slice.handleNormalizedEvent('tab1', { type: 'stream_reset' } as any)

    // stream_reset should discard the trailing assistant text
    const msgs = messages(state)
    expect(msgs.length).toBe(0)
  })
})
