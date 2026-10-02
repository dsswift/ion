import { describe, expect, it, vi } from 'vitest'

vi.mock('../settings/use-environment-enterprise-policy', () => ({ useEnvironmentEnterprisePolicy: () => null }))
vi.mock('../../studio/connection/tab-environment', () => ({ activeTabEnvironmentId: () => 'local' }))

import { managedModeMessages } from '../ManagedModeNotice'

describe('managedModeMessages', () => {
  it('says nothing on an unmanaged installation', () => {
    expect(managedModeMessages(undefined)).toEqual([])
  })

  it('says nothing when a managed installation has its policy', () => {
    expect(managedModeMessages({ managed: true })).toEqual([])
  })

  it('tells policy absent and override refused apart', () => {
    expect(managedModeMessages({ managed: true, policyAbsent: true }).map((m) => m.kind)).toEqual(['policy-absent'])
    expect(managedModeMessages({ managed: true, overrideRefused: true }).map((m) => m.kind)).toEqual(['override-refused'])
    expect(managedModeMessages({ managed: true, policyAbsent: true, overrideRefused: true }).map((m) => m.kind)).toEqual([
      'policy-absent',
      'override-refused',
    ])
  })

  it('says a managed configuration file could not be applied, managed marker or not', () => {
    const invalid = { schemaVersion: 2, supportedSchemaVersion: 1, engine: { projected: false, error: 'unsupported' } }
    expect(managedModeMessages(undefined, invalid).map((m) => m.kind)).toEqual(['managed-config-invalid'])
    expect(managedModeMessages({ managed: true, policyAbsent: true }, invalid).map((m) => m.kind)).toEqual(['managed-config-invalid', 'policy-absent'])
  })

  it('says nothing about a managed configuration that applied', () => {
    const applied = { schemaVersion: 1, supportedSchemaVersion: 1, engine: { projected: true, checksum: 'sha256:abc' } }
    expect(managedModeMessages(undefined, applied)).toEqual([])
  })
})
