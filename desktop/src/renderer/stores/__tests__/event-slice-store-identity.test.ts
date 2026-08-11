/**
 * Reference-identity invariants on the normalized-event hot path.
 *
 * Zustand re-renders a subscriber when its selected value changes by
 * reference. `tabs` is held bare by ~10 components and `conversationPanes` by
 * the tab strip plus one subscription per tab pill, so a reducer that rebuilds
 * either on every event broadcasts a re-render storm that scales with the
 * number of open tabs rather than with what actually changed. With many tabs
 * open and several agents streaming, that pinned the renderer's main thread
 * and froze the UI.
 *
 * These tests pin the invariant directly: an event that changes nothing
 * visible must leave both references untouched, and an event that does change
 * something must still produce a new reference.
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
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import type { AgentStateUpdate } from '../../../shared/types-engine'

function makeInstance(id: string) {
  return {
    id, label: id, messages: [], messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
    conversationIds: [], draftInput: '', agentStates: [] as AgentStateUpdate[],
    statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
  }
}

/** Builds a store with `tabCount` tabs; events target tab1. */
function buildHarness(tabCount = 3) {
  const inst = makeInstance('main')
  const tabs = Array.from({ length: tabCount }, (_, i) => ({
    id: `tab${i + 1}`, engineProfileId: 'test-profile', lastEventAt: 0, status: 'running',
    permissionDenied: null, contextTokens: 0, contextPercent: 0, hasUnread: false,
    queuedPrompts: [], historicalSessionIds: [], permissionMode: 'auto',
    activeRequestId: null, currentActivity: null,
  }))
  const state: any = {
    tabs,
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [inst], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

describe('normalized-event reducer — reference identity', () => {
  it('leaves tabs and conversationPanes reference-equal when an event changes nothing', () => {
    const { state, slice } = buildHarness()
    // Prime lastEventAt so the coalescing window is open.
    slice.handleNormalizedEvent('tab1', { type: 'agent_state', agents: [] } as any)

    const tabsBefore = state.tabs
    const panesBefore = state.conversationPanes

    // Same empty snapshot again: no field on the tab or instance moves.
    slice.handleNormalizedEvent('tab1', { type: 'agent_state', agents: [] } as any)

    expect(state.tabs).toBe(tabsBefore)
    expect(state.conversationPanes).toBe(panesBefore)
  })

  it('still produces new references when the event does change state', () => {
    const { state, slice } = buildHarness()
    const panesBefore = state.conversationPanes

    slice.handleNormalizedEvent('tab1', {
      type: 'agent_state',
      agents: [{ name: 'a', status: 'running' }],
    } as any)

    expect(state.conversationPanes).not.toBe(panesBefore)
  })

  it('does not restamp lastEventAt on every event', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', { type: 'agent_state', agents: [] } as any)
    const stamped = state.tabs.find((t: any) => t.id === 'tab1').lastEventAt
    expect(stamped).toBeGreaterThan(0)

    // A second event inside the coalescing window must not move the stamp,
    // because moving it would allocate a new tab object and a new tabs array.
    slice.handleNormalizedEvent('tab1', { type: 'agent_state', agents: [] } as any)
    expect(state.tabs.find((t: any) => t.id === 'tab1').lastEventAt).toBe(stamped)
  })

  it('never rewrites tabs belonging to other conversations', () => {
    const { state, slice } = buildHarness(5)
    const others = state.tabs.filter((t: any) => t.id !== 'tab1')

    slice.handleNormalizedEvent('tab1', {
      type: 'agent_state',
      agents: [{ name: 'a', status: 'running' }],
    } as any)

    for (const before of others) {
      const after = state.tabs.find((t: any) => t.id === before.id)
      expect(after).toBe(before)
    }
  })
})
