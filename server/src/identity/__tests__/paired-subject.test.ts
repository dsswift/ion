import { describe, expect, it } from 'vitest'
import { userInfo } from 'os'
import { resolvePairedSubject, isDeviceSubject, isValidPairAsName, userSubject, hostSubject } from '../paired-subject'

const host = `local:${userInfo().username}`

describe('resolvePairedSubject', () => {
  it('shared tenancy: every device acts as the host identity, whatever else it carries', () => {
    expect(resolvePairedSubject({ clientId: 'c1', sharedTenancy: true, deviceId: 'dev-1', linkSubject: 'user:bob' })).toBe(host)
    expect(hostSubject()).toBe(host)
  })

  it('an accompanying bearer names the human authoritatively, even on a shared install', () => {
    expect(resolvePairedSubject({ clientId: 'c1', sharedTenancy: true, accompanyingSubject: 'oidc:alice', deviceId: 'dev-1' })).toBe('oidc:alice')
    expect(resolvePairedSubject({ clientId: 'c1', sharedTenancy: false, accompanyingSubject: 'oidc:alice', linkSubject: 'user:bob' })).toBe('oidc:alice')
  })

  it('isolated tenancy: the link names the human; a second device of the same person shares the subject', () => {
    const laptop = resolvePairedSubject({ clientId: 'c1', sharedTenancy: false, linkSubject: userSubject('bob'), deviceId: 'dev-1' })
    const home = resolvePairedSubject({ clientId: 'c2', sharedTenancy: false, linkSubject: userSubject('bob'), deviceId: 'dev-2' })
    expect(laptop).toBe('user:bob')
    expect(home).toBe('user:bob')
  })

  it('isolated tenancy with no human named: the device is its own principal, stable across re-pairings', () => {
    expect(resolvePairedSubject({ clientId: 'c1', sharedTenancy: false, deviceId: 'dev-1' })).toBe('paired:dev-1')
    expect(resolvePairedSubject({ clientId: 'c2', sharedTenancy: false, deviceId: 'dev-1' })).toBe('paired:dev-1')
    expect(resolvePairedSubject({ clientId: 'c3', sharedTenancy: false })).toBe('paired:c3')
  })
})

describe('subject helpers', () => {
  it('recognises device-shaped subjects only', () => {
    expect(isDeviceSubject('paired:dev-1')).toBe(true)
    expect(isDeviceSubject('user:bob')).toBe(false)
    expect(isDeviceSubject(host)).toBe(false)
  })

  it('accepts short printable names and refuses separators that read as another scheme', () => {
    expect(isValidPairAsName('bob')).toBe(true)
    expect(isValidPairAsName('bob.smith@example.org')).toBe(true)
    expect(isValidPairAsName('user:bob')).toBe(false)
    expect(isValidPairAsName('')).toBe(false)
    expect(isValidPairAsName('a'.repeat(65))).toBe(false)
  })
})
