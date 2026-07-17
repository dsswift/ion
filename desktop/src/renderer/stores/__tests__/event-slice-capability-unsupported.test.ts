/**
 * capability_unsupported — normalized path.
 *
 * The engine emits engine_capability_unsupported when a requested feature
 * (e.g. plan mode) is not supported by the backend that would serve the run
 * and the prompt was declined cleanly: no run started, the session stays
 * idle. The control plane promotes it to the NormalizedEvent variant
 * `capability_unsupported` handled by handleNormalizedEvent in event-slice.ts.
 *
 * This test pins:
 *   1. The tab settles back to 'idle' (the send path set it running
 *      optimistically) — a recoverable message, never 'failed' or 'dead'.
 *   2. The reason is appended as a system message so the user sees why the
 *      prompt was declined.
 *   3. activeRequestId / currentActivity are cleared.
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
      status: 'running', // optimistic status from the send path
      lastEventAt: 0,
      permissionMode: 'plan',
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
      hasUnread: false,
      queuedPrompts: [],
      historicalSessionIds: [],
      activeRequestId: 'req-1',
      currentActivity: 'thinking',
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
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

describe('capability_unsupported (normalized path)', () => {
  it('settles the tab to idle and surfaces the reason as a system message', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'capability_unsupported',
      capability: 'plan_mode',
      backend: 'grok',
      reason: 'plan mode is not supported on the grok backend',
    } as any)

    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.status).toBe('idle') // recoverable, not failed/dead
    expect(tab.activeRequestId).toBeNull()
    expect(tab.currentActivity).toBe('')

    const pane = state.conversationPanes.get('tab1')
    const messages = pane.instances[0].messages
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toBe('plan mode is not supported on the grok backend')
  })

  it('falls back to a built message when reason is empty', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'capability_unsupported',
      capability: 'plan_mode',
      backend: 'grok',
      reason: '',
    } as any)

    const pane = state.conversationPanes.get('tab1')
    const messages = pane.instances[0].messages
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain('plan_mode')
    expect(messages[0].content).toContain('grok')
  })
})
