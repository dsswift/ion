import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn() }))

import type { EnterprisePolicy } from '@ion/shared/types-engine'
import {
  enterprisePolicyCache,
  enterprisePolicyHash,
  onEnterprisePolicyChange,
  publishEnterprisePolicy,
  settleEnterprisePolicyUnread,
  settledEnterprisePolicy,
} from '../enterprise-policy-publish'

const killSwitch = { customFields: { 'ion-desktop': { disableAutoUpdate: true } } } as unknown as EnterprisePolicy

describe('enterprise policy publish', () => {
  it('holds readers until the first read settles, then hands them that policy', async () => {
    let got: EnterprisePolicy | null | 'pending' = 'pending'
    void settledEnterprisePolicy().then((p) => { got = p })
    await Promise.resolve()
    expect(got).toBe('pending')

    const changes: Array<EnterprisePolicy | null> = []
    onEnterprisePolicyChange((p) => changes.push(p))
    publishEnterprisePolicy(killSwitch)
    await Promise.resolve()
    await Promise.resolve()
    expect(got).toEqual(killSwitch)
    expect(enterprisePolicyCache.policy).toEqual(killSwitch)
    // The first read is not a change anyone was told about: no one was welcomed before it.
    expect(changes).toEqual([])

    publishEnterprisePolicy(killSwitch)
    expect(changes).toEqual([])
    publishEnterprisePolicy(null)
    expect(changes).toEqual([null])

    settleEnterprisePolicyUnread('late failure')
    await expect(settledEnterprisePolicy()).resolves.toBeNull()
  })

  it('hashes the same policy the same way', () => {
    expect(enterprisePolicyHash(killSwitch)).toBe(enterprisePolicyHash(JSON.parse(JSON.stringify(killSwitch))))
    expect(enterprisePolicyHash(killSwitch)).not.toBe(enterprisePolicyHash(null))
    expect(enterprisePolicyHash(null)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
