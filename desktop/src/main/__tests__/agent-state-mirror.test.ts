import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
}))

import {
  recordAgentState,
  getAgentState,
  hasAgentState,
  clearAgentStateForTab,
  clearAllAgentState,
  agentStateMirrorSize,
} from '../agent-state-mirror'
import type { AgentStateUpdate } from '../../shared/types-engine'

function agents(...names: string[]): AgentStateUpdate[] {
  return names.map((n) => ({ name: n, status: 'running', metadata: { displayName: n } })) as AgentStateUpdate[]
}

beforeEach(() => clearAllAgentState())

describe('agent-state-mirror', () => {
  it('serves the roster main recorded, with no renderer round-trip', () => {
    recordAgentState('tab-1', null, agents('a', 'b'))
    expect(getAgentState('tab-1', null).map((a) => a.name)).toEqual(['a', 'b'])
  })

  it('keys extension-hosted instances separately from the bare tab', () => {
    recordAgentState('tab-1', null, agents('bare'))
    recordAgentState('tab-1', 'inst-9', agents('scoped'))

    expect(getAgentState('tab-1', null).map((a) => a.name)).toEqual(['bare'])
    expect(getAgentState('tab-1', 'inst-9').map((a) => a.name)).toEqual(['scoped'])
  })

  it('falls back to the bare key when an instance has no entry of its own', () => {
    recordAgentState('tab-1', null, agents('bare'))
    expect(getAgentState('tab-1', 'unseen-instance').map((a) => a.name)).toEqual(['bare'])
  })

  // An empty roster is the authoritative "no agents are live, drop your rows"
  // signal, so an unknown key must answer [] rather than null. A caller that
  // treated null as "skip the send" would leave the phone rendering agents the
  // desktop no longer knows about.
  it('returns an empty roster for an unknown key rather than null', () => {
    expect(getAgentState('never-seen', null)).toEqual([])
    expect(hasAgentState('never-seen', null)).toBe(false)
  })

  it('records an explicitly empty roster as a real value', () => {
    recordAgentState('tab-1', null, [])
    expect(hasAgentState('tab-1', null)).toBe(true)
    expect(getAgentState('tab-1', null)).toEqual([])
  })

  it('replaces rather than merges, matching the complete-snapshot contract', () => {
    recordAgentState('tab-1', null, agents('a', 'b', 'c'))
    recordAgentState('tab-1', null, agents('a'))
    expect(getAgentState('tab-1', null).map((x) => x.name)).toEqual(['a'])
  })

  it('copies the caller array so later mutation cannot corrupt the mirror', () => {
    const live = agents('a')
    recordAgentState('tab-1', null, live)
    live.push(...agents('injected'))
    expect(getAgentState('tab-1', null)).toHaveLength(1)
  })

  it('clears every instance of a tab on close', () => {
    recordAgentState('tab-1', null, agents('a'))
    recordAgentState('tab-1', 'i1', agents('b'))
    recordAgentState('tab-2', null, agents('c'))

    clearAgentStateForTab('tab-1')

    expect(hasAgentState('tab-1', null)).toBe(false)
    expect(hasAgentState('tab-1', 'i1')).toBe(false)
    expect(hasAgentState('tab-2', null)).toBe(true)
  })

  it('does not clear a tab whose id merely shares a prefix', () => {
    recordAgentState('tab-1', null, agents('a'))
    recordAgentState('tab-10', null, agents('b'))

    clearAgentStateForTab('tab-1')

    expect(hasAgentState('tab-10', null)).toBe(true)
  })

  it('ignores an empty tabId rather than creating a junk key', () => {
    recordAgentState('', null, agents('a'))
    expect(agentStateMirrorSize()).toBe(0)
  })

  // Without a bound this map is a slow leak of whole agent rosters across a
  // long-lived desktop session.
  it('sweeps back under the key cap instead of growing without bound', () => {
    for (let i = 0; i < 600; i++) recordAgentState(`tab-${i}`, null, agents('a'))
    expect(agentStateMirrorSize()).toBeLessThanOrEqual(512)
    // The most recent writes survive the sweep.
    expect(hasAgentState('tab-599', null)).toBe(true)
  })
})
