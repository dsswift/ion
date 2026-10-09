/**
 * policy-store — set/clear/devicePolicy/environmentPolicy, the drop rule,
 * and clear-on-offline (spec 14 §Requirements, pinned behaviors).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { policyStore } from '../policy-store'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { EnterprisePolicy } from '@ion/shared/types-engine'

vi.mock('../../../rendererLogger', () => ({ rWarn: vi.fn() }))

function policy(overrides: Partial<EnterprisePolicy> = {}): EnterprisePolicy {
  return { allowedModels: [], ...overrides }
}

describe('policyStore', () => {
  beforeEach(() => {
    policyStore._resetForTest()
  })

  it('stores and reads back one environment policy', () => {
    policyStore.set('env-b', policy({ allowedModels: ['claude'] }))
    expect(policyStore.environmentPolicy('env-b')?.allowedModels).toEqual(['claude'])
  })

  it('devicePolicy() reads only the local entry', () => {
    policyStore.set(LOCAL_ENVIRONMENT_ID, policy({ allowedModels: ['local-model'] }))
    policyStore.set('env-b', policy({ allowedModels: ['remote-model'] }))
    expect(policyStore.devicePolicy()?.allowedModels).toEqual(['local-model'])
  })

  it('unknown environments resolve to null', () => {
    expect(policyStore.environmentPolicy('never-set')).toBeNull()
    expect(policyStore.devicePolicy()).toBeNull()
  })

  // Pinned behavior 1: remote customFields['ion-desktop'] changes no desktop
  // setting, theme, or environment policy — the drop rule strips it at write.
  it('drops customFields[ion-desktop] from a non-local environment', () => {
    policyStore.set('env-b', policy({ customFields: { 'ion-desktop': { themePolicy: { themeId: 'evil', locked: true } } } }))
    expect(policyStore.environmentPolicy('env-b')?.customFields?.['ion-desktop']).toBeUndefined()
  })

  it('keeps customFields[ion-desktop] from the local environment', () => {
    policyStore.set(LOCAL_ENVIRONMENT_ID, policy({ customFields: { 'ion-desktop': { themePolicy: { themeId: 'branded', locked: true } } } }))
    expect(policyStore.devicePolicy()?.customFields?.['ion-desktop']).toEqual({ themePolicy: { themeId: 'branded', locked: true } })
  })

  it('keeps every non-ion-desktop custom field from a remote environment', () => {
    policyStore.set('env-b', policy({ customFields: { 'ion-desktop': {}, other: 'kept' } }))
    expect(policyStore.environmentPolicy('env-b')?.customFields).toEqual({ other: 'kept' })
  })

  // Pinned behavior: policy cleared on offline and restored on the next welcome.
  it('clears the policy when the environment goes offline', () => {
    policyStore.set('env-b', policy({ allowedModels: ['x'] }))
    policyStore.onPhaseChange('env-b', 'offline')
    expect(policyStore.environmentPolicy('env-b')).toBeNull()
  })

  it('clears the policy when the environment is blocked', () => {
    policyStore.set('env-b', policy({ allowedModels: ['x'] }))
    policyStore.onPhaseChange('env-b', 'blocked')
    expect(policyStore.environmentPolicy('env-b')).toBeNull()
  })

  it('a later welcome restores the policy after a clear', () => {
    policyStore.set('env-b', policy({ allowedModels: ['x'] }))
    policyStore.onPhaseChange('env-b', 'offline')
    policyStore.set('env-b', policy({ allowedModels: ['x'] }))
    expect(policyStore.environmentPolicy('env-b')?.allowedModels).toEqual(['x'])
  })

  it('does not clear on connecting/connected/degraded/hidden transitions', () => {
    policyStore.set('env-b', policy({ allowedModels: ['x'] }))
    for (const phase of ['connecting', 'connected', 'degraded', 'hidden'] as const) {
      policyStore.onPhaseChange('env-b', phase)
      expect(policyStore.environmentPolicy('env-b')?.allowedModels).toEqual(['x'])
    }
  })

  // Task 10 settings partition
  it('deviceHiddenGroups() reads only the local entry, defaulting to empty', () => {
    expect(policyStore.deviceHiddenGroups()).toEqual([])
    policyStore.setHiddenGroups(LOCAL_ENVIRONMENT_ID, ['ai', 'mcp'])
    policyStore.setHiddenGroups('env-b', ['git'])
    expect(policyStore.deviceHiddenGroups()).toEqual(['ai', 'mcp'])
  })

  it('clears hiddenGroups on offline/blocked alongside the policy', () => {
    policyStore.setHiddenGroups(LOCAL_ENVIRONMENT_ID, ['ai'])
    expect(policyStore.deviceHiddenGroups()).toEqual(['ai'])
    policyStore.onPhaseChange(LOCAL_ENVIRONMENT_ID, 'offline')
    expect(policyStore.deviceHiddenGroups()).toEqual([])
  })

  it('notifies subscribers on setHiddenGroups', () => {
    const listener = vi.fn()
    const unsubscribe = policyStore.subscribe(listener)
    policyStore.setHiddenGroups(LOCAL_ENVIRONMENT_ID, ['ai'])
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  describe('developerSurfacesFor', () => {
    const ALL_ON = { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true, profiling: true }

    it('has every surface on for an environment that has sent nothing', () => {
      expect(policyStore.developerSurfacesFor('env-b')).toEqual(ALL_ON)
    })

    it('follows what each server offers, per environment', () => {
      policyStore.setDeveloperSurfaces('env-finance', { ...ALL_ON, sourceControl: false, worktrees: false })
      expect(policyStore.developerSurfacesFor('env-finance')).toEqual({ ...ALL_ON, sourceControl: false, worktrees: false })
      expect(policyStore.developerSurfacesFor(LOCAL_ENVIRONMENT_ID)).toEqual(ALL_ON)
    })

    it('narrows every environment by this desktop\'s own device policy', () => {
      policyStore.set(LOCAL_ENVIRONMENT_ID, policy({ customFields: { 'ion-desktop': { developerSurfaces: { commitGraph: 'disabled' } } } }))
      policyStore.setDeveloperSurfaces('env-b', { ...ALL_ON, worktrees: false })
      expect(policyStore.developerSurfacesFor('env-b')).toEqual({ ...ALL_ON, commitGraph: false, worktrees: false })
    })

    it('ignores a remote server\'s device policy', () => {
      policyStore.set('env-work', policy({ customFields: { 'ion-desktop': { developerSurfaces: { sourceControl: 'disabled' } } } }))
      policyStore.setDeveloperSurfaces('env-work', ALL_ON)
      expect(policyStore.developerSurfacesFor('env-work')).toEqual(ALL_ON)
      expect(policyStore.developerSurfacesFor(LOCAL_ENVIRONMENT_ID)).toEqual(ALL_ON)
    })

    it('returns a stable snapshot until a policy changes, and forgets a cleared environment', () => {
      policyStore.setDeveloperSurfaces('env-b', { ...ALL_ON, worktrees: false })
      const first = policyStore.developerSurfacesFor('env-b')
      expect(policyStore.developerSurfacesFor('env-b')).toBe(first)
      const before = policyStore.revision()
      policyStore.clear('env-b')
      expect(policyStore.revision()).toBeGreaterThan(before)
      expect(policyStore.developerSurfacesFor('env-b')).toEqual(ALL_ON)
    })
  })
})
