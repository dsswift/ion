import { describe, expect, it } from 'vitest'
import { deriveEnterpriseSettingsEditsPolicy } from '../enterprise-settings-edits-policy'

describe('deriveEnterpriseSettingsEditsPolicy', () => {
  it('reads the seal from the server namespace', () => {
    expect(deriveEnterpriseSettingsEditsPolicy({ customFields: { 'ion-server': { agentSettingsEdits: { allowed: false } } } })).toEqual({ allowed: false })
  })
  it('is null when absent or malformed', () => {
    expect(deriveEnterpriseSettingsEditsPolicy(null)).toBeNull()
    expect(deriveEnterpriseSettingsEditsPolicy({})).toBeNull()
    expect(deriveEnterpriseSettingsEditsPolicy({ customFields: { 'ion-server': { agentSettingsEdits: { allowed: 'no' } } } })).toBeNull()
    // The device namespace is not where the seal lives.
    expect(deriveEnterpriseSettingsEditsPolicy({ customFields: { 'ion-desktop': { agentSettingsEdits: { allowed: false } } } })).toBeNull()
  })
})
