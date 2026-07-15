import { describe, it, expect, beforeEach } from 'vitest'
import {
  ATV_EVENT_TYPES,
  ATV_EVENT_RING_CAP,
  atvWantsEvent,
  updateAtvCache,
  getAtvState,
  evictAtvTab,
  clearAtvCache,
  resolveAtvPermission,
} from '../atv-state-cache'
import type { NormalizedEvent } from '../../shared/types'
import type { AgentStateUpdate } from '../../shared/types-engine'

function agent(name: string): AgentStateUpdate {
  return { name, status: 'running', metadata: {} } as AgentStateUpdate
}

function agentStateEvent(agents: AgentStateUpdate[]): NormalizedEvent {
  return { type: 'agent_state', agents } as NormalizedEvent
}

function dispatchStart(id: string): NormalizedEvent {
  return {
    type: 'dispatch_start',
    dispatchAgent: 'dev-lead',
    dispatchTask: 'task',
    dispatchModel: 'm',
    dispatchSessionId: 's',
    dispatchDepth: 1,
    dispatchParentId: '',
    dispatchId: id,
  } as NormalizedEvent
}

describe('atv-state-cache', () => {
  beforeEach(() => clearAtvCache())

  it('replaces agents wholesale on agent_state (snapshot semantics)', () => {
    updateAtvCache('tab1', agentStateEvent([agent('a'), agent('b')]))
    updateAtvCache('tab1', agentStateEvent([agent('c')]))
    const state = getAtvState('tab1')
    expect(state.agents.map((a) => a.name)).toEqual(['c'])
  })

  it('normalizes compound keys to the bare tabId (no state splitting)', () => {
    updateAtvCache('tab1:instanceA', agentStateEvent([agent('a')]))
    updateAtvCache('tab1', dispatchStart('d1'))
    const state = getAtvState('tab1')
    expect(state.agents).toHaveLength(1)
    expect(state.events).toHaveLength(1)
    // Reads through a compound key hit the same entry.
    expect(getAtvState('tab1:instanceA').agents).toHaveLength(1)
  })

  it('caps the event ring and drops the oldest entries', () => {
    for (let i = 0; i < ATV_EVENT_RING_CAP + 25; i++) {
      updateAtvCache('tab1', dispatchStart(`d${i}`))
    }
    const state = getAtvState('tab1')
    expect(state.events).toHaveLength(ATV_EVENT_RING_CAP)
    const first = state.events[0] as { dispatchId: string }
    expect(first.dispatchId).toBe('d25')
  })

  it('stores the latest status fields snapshot', () => {
    updateAtvCache('tab1', { type: 'status', fields: { state: 'running' } } as NormalizedEvent)
    updateAtvCache('tab1', { type: 'status', fields: { state: 'idle' } } as NormalizedEvent)
    expect(getAtvState('tab1').statusFields).toEqual({ state: 'idle' })
  })

  it('ignores event types outside the ATV allowlist', () => {
    updateAtvCache('tab1', { type: 'text_chunk', text: 'x' } as unknown as NormalizedEvent)
    const state = getAtvState('tab1')
    expect(state.agents).toHaveLength(0)
    expect(state.events).toHaveLength(0)
  })

  it('evicts a tab (including via compound key)', () => {
    updateAtvCache('tab1', agentStateEvent([agent('a')]))
    evictAtvTab('tab1:whatever')
    expect(getAtvState('tab1').agents).toHaveLength(0)
  })

  it('allowlist covers exactly the ATV-relevant event types', () => {
    expect([...ATV_EVENT_TYPES].sort()).toEqual([
      'agent_state',
      'dispatch_activity',
      'dispatch_end',
      'dispatch_start',
      'permission_request',
      'status',
    ])
  })

  it('dispatch_activity: tool events pass the filter, text deltas do not, none ring-cache', () => {
    const base = {
      type: 'dispatch_activity',
      dispatchAgentId: 'da-1',
      dispatchConversationId: 'c',
      dispatchSeq: 1,
    }
    const toolStart = { ...base, dispatchActivityKind: 'tool_start', toolName: 'Bash' } as unknown as NormalizedEvent
    const text = { ...base, dispatchActivityKind: 'text', dispatchTextDelta: 'x' } as unknown as NormalizedEvent
    expect(atvWantsEvent(toolStart)).toBe(true)
    expect(atvWantsEvent(text)).toBe(false)
    updateAtvCache('tab1', toolStart)
    expect(getAtvState('tab1').events).toHaveLength(0)
  })
})

describe('pending permissions (cross-surface reconcile)', () => {
  it('adds on permission_request, clears on clearing status, survives non-clearing', () => {
    const perm = { type: 'permission_request', questionId: 'q1', toolName: 'Bash', options: [] } as unknown as NormalizedEvent
    updateAtvCache('ptab', perm)
    expect(getAtvState('ptab').pendingPermissions).toHaveLength(1)
    updateAtvCache('ptab', { type: 'status', fields: { state: 'connecting' } } as unknown as NormalizedEvent)
    expect(getAtvState('ptab').pendingPermissions).toHaveLength(1)
    updateAtvCache('ptab', { type: 'status', fields: { state: 'running' } } as unknown as NormalizedEvent)
    expect(getAtvState('ptab').pendingPermissions).toHaveLength(0)
  })

  it('resolveAtvPermission removes by questionId, idempotently, and normalizes keys', () => {
    const perm = { type: 'permission_request', questionId: 'q2', toolName: 'Bash', options: [] } as unknown as NormalizedEvent
    updateAtvCache('rtab:instance-1', perm)
    expect(resolveAtvPermission('rtab', 'q2')).toBe(true)
    expect(resolveAtvPermission('rtab', 'q2')).toBe(false)
    expect(getAtvState('rtab').pendingPermissions).toHaveLength(0)
  })
})
