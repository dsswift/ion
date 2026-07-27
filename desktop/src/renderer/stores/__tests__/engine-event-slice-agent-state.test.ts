/**
 * agent_state — WI-001 normalized path snapshot contract
 *
 * After the single-path collapse (WI-001), engine_agent_state is promoted
 * to the NormalizedEvent variant `agent_state` handled by handleNormalizedEvent.
 *
 * The contract is unchanged: every emission is a COMPLETE SNAPSHOT.
 * Consumers replace local state with the payload — do not merge, retain, or
 * invent rules about which entries to preserve. See docs/architecture/agent-state.md.
 *
 * WI-001 notes:
 *   - handleEngineEvent is retired. handleNormalizedEvent is the single entry point.
 *   - agent_state comes through the normalized stream with bare tabId (not compound key).
 *   - The defensive `withRunningAgentsErrored` on engine_dead / engine_error is removed.
 *     The engine contract guarantees a final agent_state with all agents in terminal
 *     status before dying. Session failure is signaled separately via session_dead /
 *     error NormalizedEvents.
 *   - extension_died, extension_dead_permanent flow through their own NormalizedEvent
 *     variants and are tested separately.
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
import { activeInstance } from '../conversation-instance'
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

function buildHarness(agentStatesInit: AgentStateUpdate[] = []) {
  const inst = makeInstance('main')
  inst.agentStates = agentStatesInit
  const state: any = {
    tabs: [{ id: 'tab1', engineProfileId: 'test-profile', lastEventAt: 0, status: 'running', permissionDenied: null, contextTokens: 0, contextPercent: 0, hasUnread: false, queuedPrompts: [], historicalSessionIds: [], permissionMode: 'auto', activeRequestId: null, currentActivity: null }],
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

function getAgentStates(state: any): AgentStateUpdate[] | undefined {
  return activeInstance(state.conversationPanes, 'tab1')?.agentStates
}

describe('agent_state snapshot contract (WI-001 normalized path)', () => {
  it('replaces instance.agentStates with non-empty payload', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'agent_state',
      agents: [
        { name: 'a', status: 'running' },
        { name: 'b', status: 'done' },
      ],
    } as any)

    const stored = getAgentStates(state)
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(2)
    expect(stored![0].name).toBe('a')
    expect(stored![1].status).toBe('done')
  })

  it('replaces instance.agentStates with empty array — no historical preservation', () => {
    const { state, slice } = buildHarness([
      { name: 'kept', status: 'done', metadata: { conversationId: 'conv-xyz', visibility: 'sticky' } } as any,
    ])

    slice.handleNormalizedEvent('tab1', {
      type: 'agent_state',
      agents: [],
    } as any)

    const stored = getAgentStates(state)
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(0)
  })

  it('does not invent entries beyond the payload', () => {
    const { state, slice } = buildHarness([
      { name: 'old-1', status: 'done' } as any,
      { name: 'old-2', status: 'done' } as any,
    ])

    slice.handleNormalizedEvent('tab1', {
      type: 'agent_state',
      agents: [{ name: 'new', status: 'running' }],
    } as any)

    const stored = getAgentStates(state)
    expect(stored).toHaveLength(1)
    expect(stored![0].name).toBe('new')
  })

  it('handles empty/missing agents field as empty payload', () => {
    const { state, slice } = buildHarness([{ name: 'old', status: 'done' } as any])

    slice.handleNormalizedEvent('tab1', {
      type: 'agent_state',
      agents: [],
    } as any)

    const stored = getAgentStates(state)
    expect(stored).toHaveLength(0)
  })

  it('writes a new conversationPanes Map (no in-place mutation)', () => {
    const { state, slice } = buildHarness()
    const before = state.conversationPanes

    slice.handleNormalizedEvent('tab1', {
      type: 'agent_state',
      agents: [{ name: 'a', status: 'running' }],
    } as any)

    // Should construct a new Map so React detects the change.
    expect(state.conversationPanes).not.toBe(before)
  })

  it('is a no-op when tabId does not exist in conversationPanes', () => {
    const { state, slice } = buildHarness()
    const before = state.conversationPanes

    slice.handleNormalizedEvent('nonexistent-tab', {
      type: 'agent_state',
      agents: [{ name: 'x', status: 'running' }],
    } as any)

    expect(state.conversationPanes).toBe(before)
  })
})

describe('session_dead clears pending steers and flips status (WI-001)', () => {
  it('session_dead marks steerPending bubbles as steerFailed', () => {
    const { state, slice } = buildHarness()
    // Seed a pending steer bubble
    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      messages: [{ id: 'bubble', role: 'user', content: 'steer', timestamp: Date.now(), steerPending: true }],
    }

    slice.handleNormalizedEvent('tab1', { type: 'session_dead', exitCode: 1 } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    const bubble = inst?.messages.find((m: any) => m.id === 'bubble')
    expect(bubble?.steerPending).toBeUndefined()
    expect(bubble?.steerFailed).toBe(true)
  })

  it('error event marks steerPending bubbles as steerFailed', () => {
    const { state, slice } = buildHarness()
    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      messages: [{ id: 'b', role: 'user', content: 'steer', timestamp: Date.now(), steerPending: true }],
    }

    slice.handleNormalizedEvent('tab1', { type: 'error', message: 'died' } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    const bubble = inst?.messages.find((m: any) => m.id === 'b')
    expect(bubble?.steerFailed).toBe(true)
  })
})

describe('extension lifecycle events (WI-001 normalized path)', () => {
  it('extension_dead_permanent adds a system message and sets status=failed', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'extension_dead_permanent',
      extensionName: 'my-ext',
      attemptNumber: 4,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    // system message appended
    expect(inst?.messages).toHaveLength(1)
    expect(inst?.messages[0].role).toBe('system')
    expect(inst?.messages[0].content).toContain('my-ext')
    // tab status set to failed
    expect(state.tabs[0].status).toBe('failed')
  })

  it('extension_died adds an ephemeral notification (not a system message)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'extension_died',
      extensionName: 'my-ext',
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    // No system message — extension_died is ephemeral
    expect(inst?.messages).toHaveLength(0)
    // Notification toast added under bare tabId
    const notifs = state.engineNotifications.get('tab1')
    expect(notifs).toHaveLength(1)
    expect(notifs[0].level).toBe('warning')
    expect(notifs[0].message).toContain('my-ext')
  })

  it('extension_respawned adds a recovery notification', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'extension_respawned',
      extensionName: 'my-ext',
      attemptNumber: 2,
    } as any)

    const notifs = state.engineNotifications.get('tab1')
    expect(notifs).toHaveLength(1)
    expect(notifs[0].level).toBe('info')
    expect(notifs[0].message).toContain('my-ext')
    expect(notifs[0].message).toContain('2')
  })
})
