/**
 * model_fallback — WI-001 normalized path.
 *
 * After the single-path collapse (WI-001), engine_model_fallback is promoted
 * to the NormalizedEvent variant `model_fallback` handled by handleNormalizedEvent
 * in event-slice.ts.
 *
 * This test pins:
 *   1. `model_fallback` writes an entry into `engineModelFallbacks` keyed by
 *      bare tabId (one fallback slot per tab, owned by the active instance
 *      at event time).
 *   2. The subsequent `task_complete` clears the entry for that tab.
 *   3. `session_init` (while running) does not clear the entry.
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
      currentActivity: null,
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', {
      instances: [makeInstance('main')],
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

describe('model_fallback (WI-001 normalized path)', () => {
  it('writes engineModelFallbacks entry keyed by bare tabId (active instance)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'model_fallback',
      requestedModel: 'standard',
      fallbackModel: 'claude-sonnet-4-6',
      reason: 'no_provider_found',
    } as any)

    // Key is the bare tabId, not a compound key.
    const entry = state.engineModelFallbacks.get('tab1')
    expect(entry).toBeDefined()
    expect(entry?.requestedModel).toBe('standard')
    expect(entry?.fallbackModel).toBe('claude-sonnet-4-6')
    expect(entry?.reason).toBe('no_provider_found')
    expect(typeof entry?.at).toBe('number')
  })

  it('clears the entry on task_complete for the same tab', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'model_fallback',
      requestedModel: 'standard',
      fallbackModel: 'claude-sonnet-4-6',
      reason: 'no_provider_found',
    } as any)
    expect(state.engineModelFallbacks.has('tab1')).toBe(true)

    // task_complete (idle transition) should clear the indicator.
    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'sess-1',
      costUsd: 0.001,
      durationMs: 1000,
      numTurns: 1,
      permissionDenials: [],
    } as any)

    expect(state.engineModelFallbacks.has('tab1')).toBe(false)
  })

  it('does not clear the entry on session_init (running)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'model_fallback',
      requestedModel: 'standard',
      fallbackModel: 'claude-sonnet-4-6',
      reason: 'no_provider_found',
    } as any)
    expect(state.engineModelFallbacks.has('tab1')).toBe(true)

    // session_init (running) must not clear the indicator.
    slice.handleNormalizedEvent('tab1', {
      type: 'session_init',
      sessionId: 'sess-2',
      model: 'claude-sonnet-4-6',
      tools: [],
      mcpServers: [],
      skills: [],
      version: '',
      isWarmup: false,
    } as any)

    expect(state.engineModelFallbacks.has('tab1')).toBe(true)
    expect(state.engineModelFallbacks.get('tab1')?.fallbackModel).toBe('claude-sonnet-4-6')
  })
})
