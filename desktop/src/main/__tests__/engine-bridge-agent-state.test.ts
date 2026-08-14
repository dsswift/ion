import { describe, expect, it } from 'vitest'
import { agentStateFingerprint, rosterNeedsFullRecovery } from '../engine-bridge-agent-state'
import type { EngineEvent } from '../../shared/types'

function roster(keys: string[] = []): Extract<EngineEvent, { type: 'engine_agent_state' }> {
  return {
    type: 'engine_agent_state',
    agents: [{ name: 'agent', status: 'done', metadata: keys.length > 0 ? { displayName: 'Agent', _truncated: true, _truncatedKeys: keys } : { displayName: 'Agent' } }],
  }
}

describe('agent-state recovery classification', () => {
  it('requests full state only for explicitly bounded snapshots', () => {
    expect(rosterNeedsFullRecovery(roster(['lastWork']))).toBe(true)
    expect(rosterNeedsFullRecovery(roster())).toBe(false)
    expect(rosterNeedsFullRecovery({ type: 'engine_status', fields: {} } as EngineEvent)).toBe(false)
  })

  it('re-arms recovery only when bounded roster identity changes', () => {
    expect(agentStateFingerprint(roster(['task']).agents)).toBe(agentStateFingerprint(roster(['task']).agents))
    expect(agentStateFingerprint(roster(['task']).agents)).not.toBe(agentStateFingerprint(roster(['dispatches']).agents))
  })
})
