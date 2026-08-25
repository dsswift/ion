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

describe('remoteTabStatusFromEngineFields — parked guided questions', () => {
  it('an idle snapshot retaining an AskUserQuestions denial gets the completed (needs-you) treatment', () => {
    expect(
      remoteTabStatusFromEngineFields({
        state: 'idle',
        permissionDenials: [{ toolName: 'AskUserQuestions', toolUseId: 'tu-1' }],
      }),
    ).toBe('completed')
  })

  it('waiting_user is no longer a recognized state (human-wait tools park to idle)', () => {
    expect(remoteTabStatusFromEngineFields({ state: 'waiting_user' })).toBe(null)
  })
})
