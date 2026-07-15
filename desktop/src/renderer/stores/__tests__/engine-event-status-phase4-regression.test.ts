/**
 * WI-001 regression: status writes via normalized path
 *
 * After the single-path collapse (WI-001), handleEngineStatusEvent is retired.
 * The normalized arm (handleNormalizedEvent in event-slice.ts) is the single
 * authoritative source for session state. This file pins the behaviors that
 * handleEngineStatusEvent previously provided for extension tabs:
 *
 *   1. session_init captures sessionId into instance.conversationIds
 *   2. session_init with model updates instance.sessionModel
 *   3. task_complete transitions to status='completed'
 *   4. Deferred to WI-003: statusFields, contextWindow, deriveEngineParentStatus
 *
 * Note: deriveEngineParentStatus is NOT removed in WI-001 (per the spec), and
 * the parent tab's statusFields-derived logic continues to work via WI-003.
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
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

function makeInstance(id: string, conversationIds: string[] = []) {
  return {
    id, label: id, messages: [], messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
    conversationIds, draftInput: '', agentStates: [],
    statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
    dispatchTelemetry: [], contextBreakdown: null,
  }
}

function buildHarness(overrides: Partial<any> = {}) {
  const state: any = {
    tabs: [{
      id: 'tab1',
      engineProfileId: 'ext-profile',
      status: 'running',
      lastEventAt: 0,
      conversationId: null,
      lastKnownSessionId: null,
      historicalSessionIds: [],
      permissionMode: 'auto',
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
      hasUnread: false,
      queuedPrompts: [],
      activeRequestId: null,
      currentActivity: null,
      sessionTools: [],
      sessionMcpServers: [],
      sessionSkills: [],
      sessionVersion: '',
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
      instances: [makeInstance('main', overrides.conversationIds || [])],
      activeInstanceId: 'main',
    }]]),
    ...overrides,
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

describe('WI-001: session_init captures conversationId (normalized arm)', () => {
  it('appends sessionId to instance.conversationIds on first session', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'session_init',
      sessionId: 'conv-abc',
      model: 'claude-sonnet-4-6',
      tools: [],
      mcpServers: [],
      skills: [],
      version: '1',
      isWarmup: false,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.conversationIds).toContain('conv-abc')
    // tab.conversationId updated
    expect(state.tabs[0].conversationId).toBe('conv-abc')
  })

  it('does not duplicate sessionId on repeated session_init', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'session_init',
      sessionId: 'conv-abc',
      model: 'claude-sonnet-4-6',
      tools: [],
      mcpServers: [],
      skills: [],
      version: '1',
      isWarmup: false,
    } as any)

    // Resume: same sessionId re-emitted
    slice.handleNormalizedEvent('tab1', {
      type: 'session_init',
      sessionId: 'conv-abc',
      model: 'claude-sonnet-4-6',
      tools: [],
      mcpServers: [],
      skills: [],
      version: '1',
      isWarmup: false,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    const count = (inst?.conversationIds || []).filter((id) => id === 'conv-abc').length
    expect(count).toBe(1)
  })

  it('appends a new sessionId on multi-turn — prior id moves to historicalSessionIds', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'session_init',
      sessionId: 'conv-1',
      model: 'claude',
      tools: [],
      mcpServers: [],
      skills: [],
      version: '1',
      isWarmup: false,
    } as any)

    // New turn — new session
    slice.handleNormalizedEvent('tab1', {
      type: 'session_init',
      sessionId: 'conv-2',
      model: 'claude',
      tools: [],
      mcpServers: [],
      skills: [],
      version: '1',
      isWarmup: false,
    } as any)

    expect(state.tabs[0].conversationId).toBe('conv-2')
    expect(state.tabs[0].historicalSessionIds).toContain('conv-1')
    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.conversationIds).toContain('conv-2')
  })

  it('session_init updates instance.sessionModel', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'session_init',
      sessionId: 'conv-abc',
      model: 'claude-opus-4-6',
      tools: [],
      mcpServers: [],
      skills: [],
      version: '1',
      isWarmup: false,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.sessionModel).toBe('claude-opus-4-6')
  })
})

// ─── Session ledger growth on session_init (Commit 3) ─────────────────────────
describe('session ledger: session_init appends reasoned entries', () => {
  it('a plain new sessionId is appended to the ledger with reason "unknown"', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'session_init', sessionId: 'conv-1', model: 'claude',
      tools: [], mcpServers: [], skills: [], version: '1', isWarmup: false,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.sessions).toEqual([
      { id: 'conv-1', reason: 'unknown', createdAt: expect.any(Number) },
    ])
  })

  it('a checkpoint cut (pendingCutReason=clear) tags the next id "clear" with parentId', () => {
    const { state, slice } = buildHarness()

    // First session establishes the prior id.
    slice.handleNormalizedEvent('tab1', {
      type: 'session_init', sessionId: 'conv-1', model: 'claude',
      tools: [], mcpServers: [], skills: [], version: '1', isWarmup: false,
    } as any)

    // Implement clear-context stamps the cut reason on the instance.
    const pane = state.conversationPanes.get('tab1')!
    pane.instances[0].pendingCutReason = 'clear'

    // The clear-context run mints a fresh id, arriving via session_init.
    slice.handleNormalizedEvent('tab1', {
      type: 'session_init', sessionId: 'conv-2', model: 'claude',
      tools: [], mcpServers: [], skills: [], version: '1', isWarmup: false,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.sessions).toEqual([
      { id: 'conv-1', reason: 'unknown', createdAt: expect.any(Number) },
      { id: 'conv-2', reason: 'clear', createdAt: expect.any(Number), parentId: 'conv-1' },
    ])
    // The one-shot reason is consumed.
    expect(inst?.pendingCutReason).toBeUndefined()
  })

  it('repeated session_init for the same id does not duplicate the ledger entry', () => {
    const { state, slice } = buildHarness()
    const ev = {
      type: 'session_init', sessionId: 'conv-1', model: 'claude',
      tools: [], mcpServers: [], skills: [], version: '1', isWarmup: false,
    } as any
    slice.handleNormalizedEvent('tab1', ev)
    slice.handleNormalizedEvent('tab1', ev)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.sessions).toHaveLength(1)
  })
})

describe('WI-001: task_complete transitions to completed (normalized arm)', () => {
  it('task_complete without denials transitions status=completed', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'conv-1',
      costUsd: 0.01,
      durationMs: 2000,
      numTurns: 1,
      permissionDenials: [],
    } as any)

    expect(state.tabs[0].status).toBe('completed')
  })

  it('task_complete with AskUserQuestion denial sets instance.permissionDenied', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'conv-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [
        { toolName: 'AskUserQuestion', toolUseId: 'ask-1', toolInput: { question: 'Which?' } },
      ],
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.permissionDenied).not.toBeNull()
    expect(inst?.permissionDenied?.tools[0].toolName).toBe('AskUserQuestion')
    // parent tab stays null (instance-level only)
    expect(state.tabs[0].permissionDenied).toBeNull()
  })

  it('task_complete clears engineModelFallbacks entry for the active instance', () => {
    const { state, slice } = buildHarness()
    state.engineModelFallbacks.set('tab1', {
      requestedModel: 'std',
      fallbackModel: 'claude',
      reason: 'no_provider',
      at: Date.now(),
    })

    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete',
      sessionId: 'conv-1',
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
      permissionDenials: [],
    } as any)

    expect(state.engineModelFallbacks.has('tab1')).toBe(false)
  })
})
