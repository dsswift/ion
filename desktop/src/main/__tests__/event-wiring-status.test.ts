import { describe, expect, it } from 'vitest'
import { remoteTabStatusFromEngineFields } from '../event-wiring-status'

describe('remoteTabStatusFromEngineFields', () => {
  it('maps idle with exact pending work to waiting', () => {
    expect(remoteTabStatusFromEngineFields({ state: 'idle', hasPendingWork: true })).toBe('waiting')
  })

  it('maps nonzero background work to waiting for older engine emitters', () => {
    expect(remoteTabStatusFromEngineFields({ state: 'idle', backgroundAgents: 1 })).toBe('waiting')
    expect(remoteTabStatusFromEngineFields({ state: 'idle', backgroundShells: 1 })).toBe('waiting')
  })

  it('maps a clean idle to idle and preserves foreground running', () => {
    expect(remoteTabStatusFromEngineFields({ state: 'idle' })).toBe('idle')
    expect(remoteTabStatusFromEngineFields({ state: 'running' })).toBe('running')
  })
})
