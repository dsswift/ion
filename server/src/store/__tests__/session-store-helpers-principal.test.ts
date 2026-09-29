/**
 * P0: `makeLocalTab()` stamps `principalSubject` from the ambient request
 * principal (`identity/request-principal.ts`). Every one of the seven
 * tab-creation call sites spreads `...makeLocalTab()` first, so this single
 * seam is what pins the invariant for all of them.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => ({ soundEnabled: true }) },
}))
vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../model-store', () => ({
  useModelStore: { getState: () => ({ findModel: () => null }) },
}))
vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  isVisible: async () => false,
}))

import { makeLocalTab } from '../session-store-helpers'
import { runAsPrincipal } from '../../identity/request-principal'

describe('makeLocalTab: principal stamping', () => {
  it('leaves principalSubject unset outside any runAsPrincipal wrap', () => {
    const tab = makeLocalTab()
    expect(tab.principalSubject).toBeUndefined()
  })

  it('stamps principalSubject from the ambient request principal', () => {
    const tab = runAsPrincipal({ principal: { subject: 'alice', displayName: 'Alice' } }, () => makeLocalTab())
    expect(tab.principalSubject).toBe('alice')
  })

  it('stamps a fresh tab created inside a different ambient principal with that principal', () => {
    const a = runAsPrincipal({ principal: { subject: 'alice', displayName: 'Alice' } }, () => makeLocalTab())
    const b = runAsPrincipal({ principal: { subject: 'bob', displayName: 'Bob' } }, () => makeLocalTab())
    expect(a.principalSubject).toBe('alice')
    expect(b.principalSubject).toBe('bob')
  })
})
