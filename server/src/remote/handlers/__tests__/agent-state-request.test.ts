/**
 * readAgentRoster — the roster a client's request is answered from.
 *
 * The roster is served from the main-process mirror, never scraped back out
 * of a renderer. The wire wrapper that used to push it to a paired device is
 * gone; `engine.agentState` (protocol/parity-actions.ts) answers its caller
 * with what this returns, so the return value IS the contract now.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
}))
vi.mock('../../../state', () => ({ state: {} }))

import { readAgentRoster } from '../agent-state'
import {
  recordAgentState,
  clearAllAgentState,
} from '../../../engine/agent-state-mirror'

beforeEach(() => {
  clearAllAgentState()
})

describe('readAgentRoster', () => {
  it('serves the roster from the mirror with no renderer round-trip', () => {
    recordAgentState('tab-1', null, [
      { name: 'a', status: 'running', metadata: { displayName: 'A' } },
    ] as never)

    const roster = readAgentRoster('tab-1', null, 'client-1')

    expect(roster.tabId).toBe('tab-1')
    expect(roster.agents.map((a: { name: string }) => a.name)).toEqual(['a'])
  })

  // An unknown tab must still be answered. Under the complete-snapshot
  // contract an empty roster is the authoritative "no agents are live" signal;
  // staying silent would leave the client rendering rows the server no longer
  // knows about, which is the exact failure the request was sent to resolve.
  it('answers an unknown tab with an empty roster rather than staying silent', () => {
    expect(readAgentRoster('never-seen', null, 'client-1').agents).toEqual([])
  })

  it('resolves the instance from the mirror when the client omits it', () => {
    recordAgentState('tab-1', 'inst-7', [
      { name: 'scoped', status: 'running', metadata: {} },
    ] as never)

    const roster = readAgentRoster('tab-1', undefined, 'client-1')

    expect(roster.instanceId).toBe('inst-7')
    expect(roster.agents.map((a: { name: string }) => a.name)).toEqual(['scoped'])
  })

  it('honours an explicitly named instance over the mirror default', () => {
    recordAgentState('tab-1', 'inst-7', [{ name: 'seven', status: 'running', metadata: {} }] as never)
    recordAgentState('tab-1', 'inst-8', [{ name: 'eight', status: 'running', metadata: {} }] as never)

    expect(readAgentRoster('tab-1', 'inst-8', 'client-1').agents.map((a: { name: string }) => a.name))
      .toEqual(['eight'])
  })
})
