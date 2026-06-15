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
 *   - Non-empty payload → instance.agentStates is replaced with payload.
 *   - Empty payload → instance.agentStates is replaced with empty array.
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

function makeInstance(id: string, extra: Partial<any> = {}) {
  return {
    id,
    label: id,
    messages: [],
    modelOverride: null,
    permissionMode: 'auto',
    permissionDenied: null,
    conversationIds: [],
    draftInput: '',
    agentStates: [] as AgentStateUpdate[],
    statusFields: null,
    planFilePath: null,
    ...extra,
  }
}

function buildHarness() {
  const state: any = {
    tabs: [{ id: 'tab1', hasEngineExtension: true, lastEventAt: 0 }],
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [makeInstance('inst1')], activeInstanceId: 'inst1' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

/** Read agentStates from the instance in conversationPanes. */
function getAgentStates(state: any, tabId: string, instanceId: string): AgentStateUpdate[] | undefined {
  const pane = state.conversationPanes.get(tabId)
  const inst = pane?.instances.find((i: any) => i.id === instanceId)
  return inst?.agentStates
}

describe('engine_agent_state snapshot contract', () => {
  it('replaces instance.agentStates with non-empty payload', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_agent_state',
      agents: [
        { name: 'a', status: 'running' },
        { name: 'b', status: 'done' },
      ],
    } as any)

    const stored = getAgentStates(state, 'tab1', 'inst1')
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(2)
    expect(stored![0].name).toBe('a')
    expect(stored![1].status).toBe('done')
  })

  it('replaces instance.agentStates with empty array — no historical preservation', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    // Seed: pretend a sticky/done agent was previously stored on the instance.
    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      agentStates: [{ name: 'kept', status: 'done', metadata: { conversationId: 'conv-xyz', visibility: 'sticky' } }],
    }

    slice.handleEngineEvent(key, {
      type: 'engine_agent_state',
      agents: [],
    } as any)

    const stored = getAgentStates(state, 'tab1', 'inst1')
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(0)
  })

  it('does not invent entries beyond the payload', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      agentStates: [
        { name: 'old-1', status: 'done' },
        { name: 'old-2', status: 'done' },
      ],
    }

    slice.handleEngineEvent(key, {
      type: 'engine_agent_state',
      agents: [{ name: 'new', status: 'running' }],
    } as any)

    const stored = getAgentStates(state, 'tab1', 'inst1')
    expect(stored).toHaveLength(1)
    expect(stored![0].name).toBe('new')
  })

  it('handles missing agents field as empty payload', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      agentStates: [{ name: 'old', status: 'done' }],
    }

    slice.handleEngineEvent(key, { type: 'engine_agent_state' } as any)

    const stored = getAgentStates(state, 'tab1', 'inst1')
    expect(stored).toHaveLength(0)
  })

  it('ignores events when key has no instance component', () => {
    const { state, slice } = buildHarness()
    const beforePanes = state.conversationPanes

    slice.handleEngineEvent('tab1', {
      type: 'engine_agent_state',
      agents: [{ name: 'x', status: 'running' }],
    } as any)

    // No colon in key → handler returns early, conversationPanes unchanged.
    expect(state.conversationPanes).toBe(beforePanes)
  })

  it('writes a new conversationPanes Map (no in-place mutation)', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'
    const before = state.conversationPanes

    slice.handleEngineEvent(key, {
      type: 'engine_agent_state',
      agents: [{ name: 'a', status: 'running' }],
    } as any)

    // The slice should construct a new Map so React detects the change.
    expect(state.conversationPanes).not.toBe(before)
  })
})

describe('engine_dead flips running agents to error', () => {
  it('flips running agents to error and preserves done/idle/cancelled agents', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    // Seed agents in various statuses
    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      agentStates: [
        { name: 'a', status: 'running', metadata: { lastWork: 'Using Read...' } },
        { name: 'b', status: 'done', metadata: { lastWork: 'finished', elapsed: 42 } },
        { name: 'c', status: 'idle', metadata: {} },
        { name: 'd', status: 'cancelled', metadata: {} },
        { name: 'e', status: 'running', metadata: { lastWork: 'Using Bash...' } },
      ],
    }

    slice.handleEngineEvent(key, { type: 'engine_dead', exitCode: 1 } as any)

    const stored = getAgentStates(state, 'tab1', 'inst1')
    expect(stored).toHaveLength(5)
    // Running agents flipped to error
    expect(stored![0]).toEqual({ name: 'a', status: 'error', metadata: { lastWork: 'Using Read...' } })
    expect(stored![4]).toEqual({ name: 'e', status: 'error', metadata: { lastWork: 'Using Bash...' } })
    // Non-running agents preserved unchanged
    expect(stored![1]).toEqual({ name: 'b', status: 'done', metadata: { lastWork: 'finished', elapsed: 42 } })
    expect(stored![2]).toEqual({ name: 'c', status: 'idle', metadata: {} })
    expect(stored![3]).toEqual({ name: 'd', status: 'cancelled', metadata: {} })
  })

  it('is a no-op when no agents are running', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    const pane = state.conversationPanes.get('tab1')
    const originalAgents = [
      { name: 'a', status: 'done', metadata: {} },
      { name: 'b', status: 'idle', metadata: {} },
    ]
    pane.instances[0] = { ...pane.instances[0], agentStates: originalAgents }
    const beforePanes = state.conversationPanes

    slice.handleEngineEvent(key, { type: 'engine_dead', exitCode: 1 } as any)

    // No running agents → withRunningAgentsErrored returns original Map
    expect(state.conversationPanes).toBe(beforePanes)
  })

  it('does not flip agents on clean exit (exitCode 0)', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      agentStates: [{ name: 'a', status: 'running', metadata: {} }],
    }

    slice.handleEngineEvent(key, { type: 'engine_dead', exitCode: 0 } as any)

    // exitCode 0 → early return, agents untouched
    const stored = getAgentStates(state, 'tab1', 'inst1')
    expect(stored![0].status).toBe('running')
  })
})

describe('engine_error flips running agents to error', () => {
  it('flips running agents to error while adding error message', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      agentStates: [
        { name: 'a', status: 'running', metadata: { lastWork: 'Using Read...' } },
        { name: 'b', status: 'done', metadata: { elapsed: 10 } },
      ],
    }

    slice.handleEngineEvent(key, { type: 'engine_error', message: 'something broke' } as any)

    const stored = getAgentStates(state, 'tab1', 'inst1')
    expect(stored).toHaveLength(2)
    expect(stored![0].status).toBe('error')
    expect(stored![0].metadata).toEqual({ lastWork: 'Using Read...' })
    expect(stored![1].status).toBe('done')
    expect(stored![1].metadata).toEqual({ elapsed: 10 })

    // Also verify the error message was added to messages
    const inst = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'inst1')
    expect(inst.messages).toHaveLength(1)
    expect(inst.messages[0].content).toBe('Error: something broke')
  })

  it('extension_died errors route to notifications, not messages', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    const pane = state.conversationPanes.get('tab1')
    pane.instances[0] = {
      ...pane.instances[0],
      agentStates: [
        { name: 'a', status: 'running', metadata: { lastWork: 'Using Read...' } },
      ],
    }

    slice.handleEngineEvent(key, {
      type: 'engine_error',
      message: 'extension (unknown) subprocess died — hooks disabled until restart',
      errorCode: 'extension_died',
    } as any)

    // Running agents still flip to error
    const stored = getAgentStates(state, 'tab1', 'inst1')
    expect(stored![0].status).toBe('error')

    // No system message added to the conversation stream
    const inst = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'inst1')
    expect(inst.messages).toHaveLength(0)

    // Notification toast added instead
    const notifs = state.engineNotifications.get(key)
    expect(notifs).toHaveLength(1)
    expect(notifs[0].level).toBe('error')
    expect(notifs[0].message).toContain('subprocess died')
  })

  it('hook_failed errors route to notifications, not messages', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_error',
      message: 'extension hook session_start failed: jsonrpc error -32603: ctx.runOnce is not a function',
      errorCode: 'hook_failed',
    } as any)

    // No system message in the conversation stream
    const inst = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'inst1')
    expect(inst.messages).toHaveLength(0)

    // Notification toast added
    const notifs = state.engineNotifications.get(key)
    expect(notifs).toHaveLength(1)
    expect(notifs[0].level).toBe('error')
    expect(notifs[0].message).toContain('hook session_start failed')
  })

  it('extension_load_failed errors route to notifications, not messages', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_error',
      message: 'extension load failed: compilation error',
      errorCode: 'extension_load_failed',
    } as any)

    const inst = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'inst1')
    expect(inst.messages).toHaveLength(0)

    const notifs = state.engineNotifications.get(key)
    expect(notifs).toHaveLength(1)
    expect(notifs[0].level).toBe('error')
    expect(notifs[0].message).toContain('extension load failed')
  })
})

describe('engine_extension_dead_permanent routes to notifications', () => {
  it('adds a notification instead of a conversation message', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_extension_dead_permanent',
      extensionName: 'my-ext',
      attemptNumber: 4,
    } as any)

    // No system message in the conversation stream
    const inst = state.conversationPanes.get('tab1').instances.find((i: any) => i.id === 'inst1')
    expect(inst.messages).toHaveLength(0)

    // Notification toast added
    const notifs = state.engineNotifications.get(key)
    expect(notifs).toHaveLength(1)
    expect(notifs[0].level).toBe('error')
    expect(notifs[0].message).toContain('my-ext')
    expect(notifs[0].message).toContain('4 times in 60s')
    expect(notifs[0].message).toContain('will not be restarted')
  })
})
