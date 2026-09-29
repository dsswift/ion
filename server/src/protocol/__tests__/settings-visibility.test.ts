import { describe, expect, it } from 'vitest'
import { computeSettingsHiddenGroups, lockableActionGroup } from '../settings-visibility'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'

describe('computeSettingsHiddenGroups', () => {
  it('hides nothing from a non-local connection: what it may change is decided by its scopes', () => {
    expect(computeSettingsHiddenGroups({ transport: 'tcp' }, null)).toEqual([])
  })

  it('the local connection sees everything when no enterprise config is present', () => {
    expect(computeSettingsHiddenGroups({ transport: 'local' }, null)).toEqual([])
  })

  it('the local connection additionally hides groups named in the sealed hiddenSettingsGroups field', () => {
    const policy = { customFields: { 'ion-desktop': { hiddenSettingsGroups: ['mcp', 'ai'] } } } as unknown as EnterprisePolicy
    expect(computeSettingsHiddenGroups({ transport: 'local' }, policy)).toEqual(['mcp', 'ai'])
  })

  it('a non-local connection ignores hiddenSettingsGroups (device policy only ever narrows the LOCAL desktop)', () => {
    const policy = { customFields: { 'ion-desktop': { hiddenSettingsGroups: ['appearance'] } } } as unknown as EnterprisePolicy
    expect(computeSettingsHiddenGroups({ transport: 'tcp' }, policy)).toEqual([])
  })
})

describe('lockableActionGroup', () => {
  it('maps every mutating model/provider/mcp action named in the plan', () => {
    expect(lockableActionGroup('model.setTier')).toBe('ai')
    expect(lockableActionGroup('provider.setDefault')).toBe('ai')
    expect(lockableActionGroup('mcp.add')).toBe('mcp')
    expect(lockableActionGroup('mcp.remove')).toBe('mcp')
  })

  it('leaves read-only siblings unlockable', () => {
    expect(lockableActionGroup('model.list')).toBeUndefined()
    expect(lockableActionGroup('model.listTiers')).toBeUndefined()
    expect(lockableActionGroup('provider.getDefault')).toBeUndefined()
    expect(lockableActionGroup('mcp.list')).toBeUndefined()
  })

  it('returns undefined for an action outside the settings surface entirely', () => {
    expect(lockableActionGroup('renameTab')).toBeUndefined()
  })
})
