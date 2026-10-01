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
})
