import { describe, expect, it, vi } from 'vitest'
import { announceForDevice, relayOidcJoin, type RelayOidcJoinDeps } from '../relay-oidc-join'
import type { RelayAuthConfig } from '@ion/shared/relay-auth-config'

const HOME = 'https://login.example.org/home-tenant/v2.0'
const WORK = 'https://login.example.org/work-tenant/v2.0'
const RELAY = 'wss://relay.example.org'

const twoTenants: RelayAuthConfig = {
  oidc: true, psk: false, issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access',
  issuers: [
    { issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access' },
    { issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' },
  ],
}

function deps(over: Partial<RelayOidcJoinDeps> = {}): RelayOidcJoinDeps & { requestToken: ReturnType<typeof vi.fn> } {
  const requestToken = vi.fn((scope: string) => Promise.resolve({ ok: true, data: { accessToken: `token-for:${scope}`, expiresAt: Date.now() + 60_000 } }))
  return { probe: () => Promise.resolve(twoTenants), ownIssuer: () => Promise.resolve(WORK), requestToken, ...over } as RelayOidcJoinDeps & { requestToken: ReturnType<typeof vi.fn> }
}

describe('relayOidcJoin', () => {
  it('mints a token for the relay entry of the tenant the operator is signed in to, not the primary', async () => {
    const d = deps()
    await expect(relayOidcJoin(RELAY, d).getCredential()).resolves.toBe('token-for:api://work-app/Relay.Access')
    expect(d.requestToken).toHaveBeenCalledWith('api://work-app/Relay.Access', false)
  })

  it('says why when the relay does not accept the operator\'s tenant', async () => {
    const d = deps({ ownIssuer: () => Promise.resolve('https://login.example.org/stranger/v2.0') })
    await expect(relayOidcJoin(RELAY, d).getCredential()).rejects.toThrow(/does not accept tokens from/)
    expect(d.requestToken).not.toHaveBeenCalled()
  })

  it('says why when nobody is signed in and the relay offers a choice', async () => {
    await expect(relayOidcJoin(RELAY, deps({ ownIssuer: () => Promise.resolve('') })).getCredential()).rejects.toThrow(/no operator identity/)
  })

  it('uses a relay\'s only issuer without needing to match it', async () => {
    const single: RelayAuthConfig = { oidc: true, psk: false, issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access' }
    const d = deps({ probe: () => Promise.resolve(single), ownIssuer: () => Promise.resolve(`${HOME}/`) })
    await expect(relayOidcJoin(RELAY, d).getCredential()).resolves.toBe('token-for:api://home-app/Relay.Access')
  })

  it('after a rejection, bypasses the token cache once and follows a changed sign-in', async () => {
    let issuer = WORK
    const d = deps({ ownIssuer: () => Promise.resolve(issuer) })
    const join = relayOidcJoin(RELAY, d)
    await join.getCredential()

    join.onCredentialRejected()
    await join.getCredential()
    expect(d.requestToken).toHaveBeenLastCalledWith('api://work-app/Relay.Access', true)

    issuer = HOME
    join.onCredentialRejected()
    await expect(join.getCredential()).resolves.toBe('token-for:api://home-app/Relay.Access')
  })
})

describe('announceForDevice', () => {
  it('announces the relay entry for the device\'s tenant, pinned to its subject', () => {
    expect(announceForDevice(twoTenants, { issuer: HOME, subject: 'oid-home' }, RELAY))
      .toEqual({ issuer: HOME, audience: 'api://home-app', scope: 'Relay.Access', subject: 'oid-home' })
  })

  it('announces nothing for a device that gave no identity, or whose tenant the relay refuses', () => {
    expect(announceForDevice(twoTenants, undefined, RELAY)).toBeUndefined()
    expect(announceForDevice(twoTenants, { issuer: 'https://login.example.org/stranger/v2.0', subject: 's' }, RELAY)).toBeUndefined()
    expect(announceForDevice(null, { issuer: HOME, subject: 'oid-home' }, RELAY)).toBeUndefined()
  })
})
