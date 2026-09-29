import { describe, expect, it, vi } from 'vitest'
import { relayOidcJoin, relayIssuerInUse } from '../relay-oidc-join'
import { advertisedRelays } from '../../auth/relay-advertise'
import { isEnvironmentRelay } from '@ion/shared/studio-wire/relay-envelope'
import type { RelayAuthConfig } from '@ion/shared/relay-auth-config'
import type { ServerConfig } from '../../config/server-config'

const signInApp = vi.hoisted(() => ({ clientId: 'work-sign-in-app' }))
vi.mock('../../oauth/entra-auth', () => ({ getConfiguredOidcClientId: () => signInApp.clientId }))

const HOME = 'https://login.example.org/home-tenant/v2.0'
const WORK = 'https://login.example.org/work-tenant/v2.0'
const RELAY = 'wss://tenants.relay.example.org'

const twoTenants: RelayAuthConfig = {
  oidc: true, psk: false, issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access',
  issuers: [
    { issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access' },
    { issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' },
  ],
}

const config = { oidc: null, relays: [{ url: RELAY, psk: '', oidc: true }] } as unknown as ServerConfig

/**
 * A relay binds each channel to the first account that joins it. A client
 * that joins a work server's channel from its personal tenant is refused, or
 * claims the channel first and locks the server out. So a paired client is
 * told which tenant this server joins the relay with.
 */
describe('the tenant a relay-oidc relay is advertised with', () => {
  it('is absent until this server has joined, then names the tenant it joined with', async () => {
    expect(relayIssuerInUse(RELAY)).toBeUndefined()
    expect(advertisedRelays(config)).toEqual([{ url: RELAY, auth: { mode: 'relay-oidc' } }])

    const requestToken = vi.fn(() => Promise.resolve({ ok: true, data: { accessToken: 't', expiresAt: Date.now() + 60_000 } }))
    await relayOidcJoin(RELAY, { probe: () => Promise.resolve(twoTenants), ownIssuer: () => Promise.resolve(WORK), requestToken }).getCredential()

    expect(relayIssuerInUse(RELAY)).toBe(WORK)
    const [advertised] = advertisedRelays(config)
    // The sign-in app travels with the tenant: the relay's entry names only
    // its own API app, which a client cannot sign in as.
    expect(advertised).toEqual({ url: RELAY, auth: { mode: 'relay-oidc', issuer: WORK, clientId: 'work-sign-in-app' } })
    expect(isEnvironmentRelay(advertised)).toBe(true)
  })

  it('leaves the sign-in app out when this install has none configured', () => {
    signInApp.clientId = ''
    try {
      expect(advertisedRelays(config)).toEqual([{ url: RELAY, auth: { mode: 'relay-oidc', issuer: WORK } }])
    } finally {
      signInApp.clientId = 'work-sign-in-app'
    }
  })

  it('still accepts an advertisement without the field, and refuses a malformed one', () => {
    expect(isEnvironmentRelay({ url: RELAY, auth: { mode: 'relay-oidc' } })).toBe(true)
    expect(isEnvironmentRelay({ url: RELAY, auth: { mode: 'relay-oidc', issuer: 42 } })).toBe(false)
    expect(isEnvironmentRelay({ url: RELAY, auth: { mode: 'relay-oidc', issuer: WORK, clientId: 7 } })).toBe(false)
  })
})
