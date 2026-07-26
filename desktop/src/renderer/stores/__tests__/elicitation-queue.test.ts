/**
 * Elicitation queue handling (extension ctx.elicit) via the normalized path.
 *
 * Regression coverage for the dev-lead dispatch stall: an extension calls
 * ctx.elicit(); the engine fans engine_elicitation_request to the client and
 * parks on an indefinite human-wait. The desktop must translate that into an
 * `elicitation_request` NormalizedEvent (engine-control-plane-events.ts) and
 * push it onto the active instance's elicitationQueue here, so the renderer
 * can show an approval card. respondElicitation removes the entry.
 *
 * Reverting the event-slice arm (the elicitation_request case) drops the
 * event and leaves elicitationQueue empty — these tests go red.
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
import { createPermissionsSlice } from '../slices/permissions-slice'
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
    tabs: [{ id: 'tab1', engineProfileId: 'test-profile', status: 'running', lastEventAt: 0, permissionDenied: null, contextTokens: 0, contextPercent: 0, permissionMode: 'auto', hasUnread: false, queuedPrompts: [], historicalSessionIds: [], activeRequestId: null, currentActivity: null }],
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
  const slice = { ...createEventSlice(set, get), ...createPermissionsSlice(set, get) } as State
  return { state, slice }
}

function getQueue(state: any, tabId: string) {
  return activeInstance(state.conversationPanes, tabId)?.elicitationQueue ?? []
}

describe('elicitation_request — pushed onto the active instance elicitationQueue', () => {
  it('pushes a queued elicitation with requestId, mode, and schema', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'elicitation_request',
      requestId: 'elicit-1',
      mode: 'approval',
      schema: { action: 'dispatch_agent', agent: 'dev-lead', tier: 'T4' },
    } as any)

    const queue = getQueue(state, 'tab1')
    expect(queue).toHaveLength(1)
    expect(queue[0].requestId).toBe('elicit-1')
    expect(queue[0].mode).toBe('approval')
    expect(queue[0].schema).toEqual({ action: 'dispatch_agent', agent: 'dev-lead', tier: 'T4' })
  })

  it('accumulates multiple concurrent elicitations in order', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', { type: 'elicitation_request', requestId: 'e1', mode: 'approval' } as any)
    slice.handleNormalizedEvent('tab1', { type: 'elicitation_request', requestId: 'e2', mode: 'approval' } as any)

    const queue = getQueue(state, 'tab1')
    expect(queue.map((e: any) => e.requestId)).toEqual(['e1', 'e2'])
  })

  it('is run-scoped: a terminal status clears the queue', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', { type: 'elicitation_request', requestId: 'e1', mode: 'approval' } as any)
    expect(getQueue(state, 'tab1')).toHaveLength(1)

    // task_complete is a terminal status; the queue must drain (stale once
    // the run ends, exactly like permissionQueue).
    slice.handleNormalizedEvent('tab1', {
      type: 'task_complete', sessionId: 's', costUsd: 0, durationMs: 0, numTurns: 1, permissionDenials: [],
    } as any)

    expect(getQueue(state, 'tab1')).toHaveLength(0)
  })
})

describe('respondElicitation — answers and removes the entry', () => {
  it('approve sends {} + cancelled=false and removes the entry', () => {
    const { state, slice } = buildHarness()
    const respondElicitation = vi.fn().mockResolvedValue(true)
    ;(globalThis as any).window = { ion: { respondElicitation } }

    slice.handleNormalizedEvent('tab1', { type: 'elicitation_request', requestId: 'e1', mode: 'approval' } as any)
    expect(getQueue(state, 'tab1')).toHaveLength(1)

    slice.respondElicitation('tab1', 'e1', {}, false)

    expect(respondElicitation).toHaveBeenCalledWith('tab1', 'e1', {}, false)
    expect(getQueue(state, 'tab1')).toHaveLength(0)
  })

  it('cancel sends cancelled=true and removes the entry', () => {
    const { state, slice } = buildHarness()
    const respondElicitation = vi.fn().mockResolvedValue(true)
    ;(globalThis as any).window = { ion: { respondElicitation } }

    slice.handleNormalizedEvent('tab1', { type: 'elicitation_request', requestId: 'e1', mode: 'approval' } as any)
    slice.respondElicitation('tab1', 'e1', undefined, true)

    expect(respondElicitation).toHaveBeenCalledWith('tab1', 'e1', undefined, true)
    expect(getQueue(state, 'tab1')).toHaveLength(0)
  })

  it('answering one of two leaves the other queued', () => {
    const { state, slice } = buildHarness()
    const respondElicitation = vi.fn().mockResolvedValue(true)
    ;(globalThis as any).window = { ion: { respondElicitation } }

    slice.handleNormalizedEvent('tab1', { type: 'elicitation_request', requestId: 'e1', mode: 'approval' } as any)
    slice.handleNormalizedEvent('tab1', { type: 'elicitation_request', requestId: 'e2', mode: 'approval' } as any)

    slice.respondElicitation('tab1', 'e1', {}, false)

    const queue = getQueue(state, 'tab1')
    expect(queue).toHaveLength(1)
    expect(queue[0].requestId).toBe('e2')
  })
})
