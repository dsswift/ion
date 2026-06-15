/**
 * engine-event-slice — engine_message_end does NOT idle the tab
 *
 * Regression pin for the "flickering Interrupt button between tool calls"
 * fix. The engine emits `engine_message_end` at the end of every LLM
 * message, not at run completion. A single SendPrompt commonly produces
 * several LLM messages (assistant → tool_use → tool_result → assistant
 * → …), and historically the desktop renderer flipped `tab.status` to
 * 'idle' on each one — only to flip it back to 'running' on the next
 * `engine_text_delta`. That flicker stripped the Interrupt button, the
 * "Thinking…" pulse, and the outer tab-pill dot between turns.
 *
 * The authoritative idle signal is `engine_status { state: "idle" }`,
 * which the engine emits exactly once at true run-exit. This test pins:
 *
 *   1. After `engine_message_end`, `tab.status` MUST still be 'running'.
 *      Usage/cost fields are still updated (they're per-message).
 *   2. Only an explicit `engine_status { state: "idle" }` transitions
 *      the tab to 'idle'.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createEngineEventSlice } from '../slices/engine-event-slice'
import type { State } from '../session-store-types'

function buildHarness() {
  const state: any = {
    tabs: [{
      id: 'tab1',
      hasEngineExtension: true,
      status: 'running',
      lastEventAt: 0,
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
    }],
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [{ id: 'inst1', label: 'inst1', messages: [], modelOverride: null, permissionMode: 'auto', permissionDenied: null, conversationIds: [], draftInput: '', agentStates: [], statusFields: null, planFilePath: null }], activeInstanceId: 'inst1' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

describe('engine_message_end does not flip tab to idle', () => {
  it('leaves status=running after a mid-run engine_message_end', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    // Simulate a mid-run message end (e.g. assistant text just before a tool call).
    slice.handleEngineEvent(key, {
      type: 'engine_message_end',
      usage: { inputTokens: 1234, contextPercent: 12.5, cost: 0.0042 },
    } as any)

    // Status must remain 'running' — the next engine_text_delta would
    // also set 'running', but if we flickered to 'idle' here the
    // Interrupt button vanishes for the user.
    expect(state.tabs[0].status).toBe('running')

    // Usage fields are still updated — they're per-message accounting
    // and correct between turns.
    expect(state.tabs[0].contextTokens).toBe(1234)
    expect(state.tabs[0].contextPercent).toBe(12.5)
    const usage = state.engineUsage.get(key)
    expect(usage).toEqual({ percent: 12.5, tokens: 1234, cost: 0.0042 })
  })

  it('only transitions to idle on explicit engine_status { state: "idle" }', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_message_end',
      usage: { inputTokens: 100, contextPercent: 1, cost: 0.001 },
    } as any)
    expect(state.tabs[0].status).toBe('running')

    // Engine reports true run-exit.
    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: { state: 'idle' },
    } as any)
    expect(state.tabs[0].status).toBe('idle')
  })

  it('handles engine_message_end without usage payload — status untouched', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, { type: 'engine_message_end' } as any)

    expect(state.tabs[0].status).toBe('running')
    expect(state.tabs[0].contextTokens).toBe(0)
    expect(state.tabs[0].contextPercent).toBe(0)
    expect(state.engineUsage.get(key)).toBeUndefined()
  })
})
