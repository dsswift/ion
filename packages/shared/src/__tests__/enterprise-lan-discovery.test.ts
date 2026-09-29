import { describe, expect, it } from 'vitest'
import { lanDiscoverySealed } from '../enterprise-lan-discovery'

describe('lanDiscoverySealed', () => {
  it('is sealed only by an explicit disabled under the ion-studio namespace', () => {
    expect(lanDiscoverySealed({ customFields: { 'ion-studio': { lanDiscovery: 'disabled' } } })).toBe(true)
    expect(lanDiscoverySealed({ customFields: { 'ion-studio': { lanDiscovery: 'allowed' } } })).toBe(false)
    expect(lanDiscoverySealed({ customFields: { 'ion-desktop': { lanDiscovery: 'disabled' } } })).toBe(false)
    expect(lanDiscoverySealed({ customFields: {} })).toBe(false)
    expect(lanDiscoverySealed(null)).toBe(false)
  })
})
