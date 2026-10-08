import { describe, expect, it } from 'vitest'
import { mapBrokerPhase } from '../phases'

describe('mapBrokerPhase', () => {
  it('reads a failed attempt with no further detail as an unreachable server', () => {
    expect(mapBrokerPhase({ phase: 'offline', transport: 'tcp', reason: 'fetch failed' })).toEqual({ phase: 'offline', reason: 'server_unreachable' })
  })

  it('reads a welcome this build could not read as a version mismatch, not an absent server', () => {
    expect(mapBrokerPhase({ phase: 'offline', transport: 'tcp', reason: 'welcome could not be read', incompatible: true })).toEqual({ phase: 'offline', reason: 'protocol_version' })
    expect(mapBrokerPhase({ phase: 'backoff', transport: 'ssh', reason: 'welcome could not be read', incompatible: true, attempt: 1, nextAttemptAtMs: 0 }).reason).toBe('protocol_version')
  })

  it('lets a server refusal decide the reason', () => {
    expect(mapBrokerPhase({ phase: 'offline', transport: 'tcp', reason: 'refused', refusalReason: 'unauthorized' }).reason).toBe('not_assigned')
  })
})
