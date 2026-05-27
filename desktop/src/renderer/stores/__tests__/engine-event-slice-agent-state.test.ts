/**
 * engine-event-slice — `engine_agent_state` snapshot contract
 *
 * The engine emits `engine_agent_state` as a COMPLETE SNAPSHOT of every
 * agent it considers live. Consumers replace local state with the
 * payload — they do not merge, retain, or invent rules about which
 * entries to preserve. See docs/architecture/agent-state.md.
 *
 * These tests pin that contract on the desktop renderer:
 *
 *   - Non-empty payload → state is replaced with payload.
 *   - Empty payload → state is replaced with empty array (no historical
 *     preservation; that was the bug we removed).
 *   - The slice never invents entries that aren't in the engine's payload.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createEngineEventSlice } from '../slices/engine-event-slice'
import type { State } from '../session-store-types'
import type { AgentStateUpdate } from '../../../shared/types-engine'

function buildHarness() {
  const state: any = {
    tabs: [{ id: 'tab1', isEngine: true, lastEventAt: 0 }],
    engineAgentStates: new Map<string, AgentStateUpdate[]>(),
    engineStatusFields: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineMessages: new Map(),
    engineDraftInputs: new Map(),
    engineModelOverrides: new Map(),
    engineConversationIds: new Map(),
    enginePanes: new Map(),
    enginePermissionDenied: new Map(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

describe('engine_agent_state snapshot contract', () => {
  it('replaces state with non-empty payload', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_agent_state',
      agents: [
        { name: 'a', status: 'running' },
        { name: 'b', status: 'done' },
      ],
    } as any)

    const stored = state.engineAgentStates.get(key)
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(2)
    expect(stored![0].name).toBe('a')
    expect(stored![1].status).toBe('done')
  })

  it('replaces state with empty array — no historical preservation', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    // Seed: pretend a sticky/done agent with conversationId was previously stored.
    // Under the old (buggy) preservation rule this row would survive an empty
    // emission. Under the corrected contract it must be wiped because the
    // engine no longer endorses it.
    state.engineAgentStates.set(key, [
      { name: 'kept', status: 'done', metadata: { conversationId: 'conv-xyz', visibility: 'sticky' } },
    ])

    slice.handleEngineEvent(key, {
      type: 'engine_agent_state',
      agents: [],
    } as any)

    const stored = state.engineAgentStates.get(key)
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(0)
  })

  it('does not invent entries beyond the payload', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    state.engineAgentStates.set(key, [
      { name: 'old-1', status: 'done' },
      { name: 'old-2', status: 'done' },
    ])

    slice.handleEngineEvent(key, {
      type: 'engine_agent_state',
      agents: [{ name: 'new', status: 'running' }],
    } as any)

    const stored = state.engineAgentStates.get(key)
    expect(stored).toHaveLength(1)
    expect(stored![0].name).toBe('new')
  })

  it('handles missing agents field as empty payload', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    state.engineAgentStates.set(key, [{ name: 'old', status: 'done' }])

    // event.agents undefined — should be treated as []
    slice.handleEngineEvent(key, { type: 'engine_agent_state' } as any)

    const stored = state.engineAgentStates.get(key)
    expect(stored).toHaveLength(0)
  })

  it('ignores events when key has no instance component', () => {
    const { state, slice } = buildHarness()

    slice.handleEngineEvent('tab1', {
      type: 'engine_agent_state',
      agents: [{ name: 'x', status: 'running' }],
    } as any)

    // No colon in key → handler returns early.
    expect(state.engineAgentStates.size).toBe(0)
  })

  it('writes a new Map (no in-place mutation)', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'
    const before = state.engineAgentStates

    slice.handleEngineEvent(key, {
      type: 'engine_agent_state',
      agents: [{ name: 'a', status: 'running' }],
    } as any)

    // The slice should construct a new Map so React detects the change.
    expect(state.engineAgentStates).not.toBe(before)
  })
})
