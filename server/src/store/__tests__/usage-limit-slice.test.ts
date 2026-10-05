/**
 * The Limited state and the prompt a server holds for a conversation:
 * what sets and lifts the limit, and what a held prompt does when released.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(), nextMsgId: vi.fn(() => 'mock-msg-id'), playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0), scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false, usageLimitResumePrompt: ' Pick it back up. ' })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({ handleCrossNormalizedEvent: vi.fn(() => false) }))
vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rTrace: vi.fn() }))

import { createEventSlice } from '../slices/event-slice'
import { createUsageLimitSlice } from '../slices/usage-limit-slice'
import type { State } from '../session-store-types'

const HOUR = 3_600_000

function harness(tabOver: Record<string, unknown> = {}) {
  const submit = vi.fn(() => ({ accepted: true }))
  const snoozeTab = vi.fn()
  const state: any = {
    tabs: [{
      id: 'tab1', status: 'running', lastEventAt: 0, queuedPrompts: [], historicalSessionIds: [], activeRequestId: null,
      currentActivity: null, isTerminalOnly: false, inputLocked: false, settledOverride: null, usageLimit: null, deferredSend: null, ...tabOver,
    }],
    activeTabId: 'tab1', engineWorkingMessages: new Map(), engineNotifications: new Map(), engineDialogs: new Map(),
    enginePinnedPrompt: new Map(), engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { activeInstanceId: 'main', instances: [{
      id: 'main', label: 'main', messages: [], messageCount: 0, permissionQueue: [], elicitationQueue: [], permissionDenied: null,
      conversationIds: [], agentStates: [], statusFields: null, planFilePath: null,
    }] }]]),
    submit, snoozeTab,
  }
  const set = (partial: any): void => { Object.assign(state, typeof partial === 'function' ? partial(state) : partial) }
  const get = () => state as State
  Object.assign(state, createEventSlice(set, get), createUsageLimitSlice(set, get))
  return { state: state as State & Record<string, any>, submit, snoozeTab }
}

const rejected = (resetsAt: number) => ({ type: 'rate_limit', status: 'rejected', rateLimitType: 'five_hour', resetsAt } as const)

describe('the backend refuses a run', () => {
  it('marks the conversation limited until the reset, in ms', () => {
    const { state } = harness()
    state.handleNormalizedEvent('tab1', rejected(1_800_000_000))
    expect(state.tabs[0].usageLimit).toMatchObject({ limitType: 'five_hour', resetsAt: 1_800_000_000_000 })
  })

  it('lifts the limit when the backend next allows a request', () => {
    const { state } = harness()
    state.handleNormalizedEvent('tab1', rejected(1_800_000_000))
    state.handleNormalizedEvent('tab1', { type: 'rate_limit', status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1_800_000_000 })
    expect(state.tabs[0].usageLimit).toBeNull()
  })
})

describe('a held prompt', () => {
  const limited = { usageLimit: { limitType: 'five_hour', resetsAt: Date.now() + HOUR, hitAt: Date.now() } }

  it('is refused for a reset when nothing limits the conversation', () => {
    const { state } = harness()
    expect(state.deferSend('tab1', 'Continue.', 'limit-reset')).toBe(false)
    expect(state.deferSend('tab1', '   ', 'spare-quota')).toBe(false)
    expect(state.tabs[0].deferredSend).toBeNull()
  })

  it('holds this server\'s own resume prompt when asked to resume at reset', () => {
    const { state } = harness(limited)
    expect(state.resumeAtLimitReset('tab1')).toBe(true)
    expect(state.tabs[0].deferredSend).toMatchObject({ text: 'Pick it back up.', release: 'limit-reset' })
  })

  it('is kept on the conversation and can be cancelled', () => {
    const { state } = harness(limited)
    expect(state.deferSend('tab1', ' Continue. ', 'limit-reset')).toBe(true)
    expect(state.tabs[0].deferredSend).toMatchObject({ text: 'Continue.', release: 'limit-reset' })
    state.cancelDeferredSend('tab1')
    expect(state.tabs[0].deferredSend).toBeNull()
  })

  it('is sent once as a published user turn, and lifts the limit it waited on', () => {
    const { state, submit } = harness(limited)
    state.deferSend('tab1', 'Continue.', 'limit-reset')
    expect(state.releaseDeferredSend('tab1')).toBe(true)
    expect(submit).toHaveBeenCalledWith('tab1', 'Continue.', { publishUserTurn: true })
    expect(state.tabs[0].deferredSend).toBeNull()
    expect(state.tabs[0].usageLimit).toBeNull()
    expect(state.releaseDeferredSend('tab1')).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('stays held when the send is refused', () => {
    const { state, submit } = harness(limited)
    state.deferSend('tab1', 'Continue.', 'limit-reset')
    submit.mockReturnValueOnce({ accepted: false, reason: 'connecting', message: 'x' } as never)
    expect(state.releaseDeferredSend('tab1')).toBe(false)
    expect(state.tabs[0].deferredSend).toMatchObject({ text: 'Continue.' })
    expect(state.tabs[0].usageLimit).not.toBeNull()
  })

  it('snoozes a limited conversation until its reset', () => {
    const { state, snoozeTab } = harness(limited)
    state.snoozeUntilLimitReset('tab1')
    expect(snoozeTab).toHaveBeenCalledWith('tab1', limited.usageLimit.resetsAt)
  })
})
