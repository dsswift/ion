/**
 * engine-event-slice — engine_model_fallback handling.
 *
 * The engine emits `engine_model_fallback` once per run when the
 * requested model couldn't be resolved to a provider and the runloop
 * fell back to the configured `defaultModel`. The desktop renderer's
 * policy (one possible consumer choice — see CLAUDE.md § "The
 * typed-event corollary") is to display a ⚠ glyph on the affected
 * EngineTabStrip pill until the next idle transition.
 *
 * This test pins:
 *
 *   1. `engine_model_fallback` writes a per-instance entry into the
 *      `engineModelFallbacks` map keyed by `${tabId}:${instanceId}`.
 *   2. The subsequent `engine_status { state: "idle" }` for the same
 *      instance clears the entry.
 *   3. Other instances are unaffected (write and clear are per-key).
 *
 * Auto-clear semantics: no wall-clock timer. The indicator stays
 * sticky until the run actually completes — if the run never goes
 * idle, the indicator persists, which is the correct UX because the
 * underlying configuration mistake (missing tiers.standard) is still
 * latent.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
}))

import { createEngineEventSlice } from '../slices/engine-event-slice'
import { handleEngineStatusEvent } from '../slices/engine-event-status'
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
      historicalSessionIds: [],
    }],
    activeTabId: 'tab1',
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([
      ['tab1', { instances: [
        { id: 'inst1', label: 'inst1', messages: [], modelOverride: null, permissionMode: 'auto', permissionDenied: null, conversationIds: [], draftInput: '', agentStates: [], statusFields: null, planFilePath: null },
        { id: 'inst-a', label: 'inst-a', messages: [], modelOverride: null, permissionMode: 'auto', permissionDenied: null, conversationIds: [], draftInput: '', agentStates: [], statusFields: null, planFilePath: null },
        { id: 'inst-b', label: 'inst-b', messages: [], modelOverride: null, permissionMode: 'auto', permissionDenied: null, conversationIds: [], draftInput: '', agentStates: [], statusFields: null, planFilePath: null },
      ], activeInstanceId: 'inst1' }],
    ]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice, set }
}

describe('engine_model_fallback slice handling', () => {
  it('writes engineModelFallbacks entry keyed by tabId:instanceId', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_model_fallback',
      fallbackRequestedModel: 'standard',
      fallbackModel: 'claude-sonnet-4-6',
      fallbackReason: 'no_provider_found',
    } as any)

    const entry = state.engineModelFallbacks.get(key)
    expect(entry).toBeDefined()
    expect(entry?.requestedModel).toBe('standard')
    expect(entry?.fallbackModel).toBe('claude-sonnet-4-6')
    expect(entry?.reason).toBe('no_provider_found')
    expect(typeof entry?.at).toBe('number')
  })

  it('clears the entry on engine_status state=idle for the same instance', () => {
    const { state, slice, set } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_model_fallback',
      fallbackRequestedModel: 'standard',
      fallbackModel: 'claude-sonnet-4-6',
      fallbackReason: 'no_provider_found',
    } as any)
    expect(state.engineModelFallbacks.has(key)).toBe(true)

    // Drive the idle transition through the status handler directly —
    // the slice's case 'engine_status' delegates to handleEngineStatusEvent.
    handleEngineStatusEvent(set, key, 'tab1', {
      type: 'engine_status',
      fields: { state: 'idle' },
    } as any)

    expect(state.engineModelFallbacks.has(key)).toBe(false)
  })

  it('leaves other instances untouched on write and clear', () => {
    const { state, slice, set } = buildHarness()
    const a = 'tab1:inst-a'
    const b = 'tab1:inst-b'

    slice.handleEngineEvent(a, {
      type: 'engine_model_fallback',
      fallbackRequestedModel: 'standard',
      fallbackModel: 'claude-sonnet-4-6',
      fallbackReason: 'no_provider_found',
    } as any)
    slice.handleEngineEvent(b, {
      type: 'engine_model_fallback',
      fallbackRequestedModel: 'fast',
      fallbackModel: 'claude-haiku-4-5',
      fallbackReason: 'no_provider_found',
    } as any)

    expect(state.engineModelFallbacks.size).toBe(2)

    // Idle only instance A — B's indicator must stay.
    handleEngineStatusEvent(set, a, 'tab1', {
      type: 'engine_status',
      fields: { state: 'idle' },
    } as any)

    expect(state.engineModelFallbacks.has(a)).toBe(false)
    expect(state.engineModelFallbacks.has(b)).toBe(true)
    expect(state.engineModelFallbacks.get(b)?.fallbackModel).toBe('claude-haiku-4-5')
  })

  it('does not perturb the entry on a running-state engine_status tick', () => {
    const { state, slice, set } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_model_fallback',
      fallbackRequestedModel: 'standard',
      fallbackModel: 'claude-sonnet-4-6',
      fallbackReason: 'no_provider_found',
    } as any)
    expect(state.engineModelFallbacks.has(key)).toBe(true)

    // A status tick that is NOT idle (cost-only update, running, etc.)
    // must not clear the indicator. The renderer's auto-clear rule is
    // tied to the idle transition specifically.
    handleEngineStatusEvent(set, key, 'tab1', {
      type: 'engine_status',
      fields: { state: 'running', totalCostUsd: 0.001 },
    } as any)

    expect(state.engineModelFallbacks.has(key)).toBe(true)
    expect(state.engineModelFallbacks.get(key)?.fallbackModel).toBe('claude-sonnet-4-6')
  })
})
