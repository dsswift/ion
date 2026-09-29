import { describe, expect, it } from 'vitest'
import { chooseRelayIssuer, composeOidcScope, parseRelayAuthConfig, relayIssuers, selectRelayIssuer } from '../relay-auth-config'

const HOME = 'https://login.example.org/home-tenant/v2.0'
const WORK = 'https://login.example.org/work-tenant/v2.0'

describe('relay auth config', () => {
  it('reads a relay that accepts several issuers and picks the one a client is signed in to', () => {
    const config = parseRelayAuthConfig({
      oidc: true, psk: false, issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access',
      issuers: [
        { issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access' },
        { issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' },
      ],
    })
    expect(config).not.toBeNull()
    const work = selectRelayIssuer(config!, WORK)
    expect(work).toEqual({ issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' })
    expect(composeOidcScope(work!.audience, work!.requiredScope)).toBe('api://work-app/Relay.Access')
    expect(selectRelayIssuer(config!, HOME)?.audience).toBe('api://home-app')
  })

  it('refuses an issuer the relay does not list, including a near match', () => {
    const config = parseRelayAuthConfig({ oidc: true, psk: false, issuer: HOME, audience: 'a', requiredScope: 's' })!
    expect(selectRelayIssuer(config, WORK)).toBeNull()
    expect(selectRelayIssuer(config, `${HOME}/`)).toBeNull()
    expect(selectRelayIssuer(config, '')).toBeNull()
  })

  it('treats a relay that lists no issuers as accepting exactly its top-level one', () => {
    const config = parseRelayAuthConfig({ oidc: true, psk: true, issuer: HOME, audience: 'a', requiredScope: 's' })!
    expect(relayIssuers(config)).toEqual([{ issuer: HOME, audience: 'a', requiredScope: 's' }])
  })

  it('chooses a relay\'s only issuer without a match, and demands a match when there are several', () => {
    const one = parseRelayAuthConfig({ oidc: true, psk: false, issuer: HOME, audience: 'a', requiredScope: 's' })!
    expect(chooseRelayIssuer(one, '')?.issuer).toBe(HOME)
    expect(chooseRelayIssuer(one, WORK)?.issuer).toBe(HOME)
    const two = parseRelayAuthConfig({ oidc: true, psk: false, issuer: HOME, audience: 'a', requiredScope: 's', issuers: [{ issuer: HOME, audience: 'a', requiredScope: 's' }, { issuer: WORK, audience: 'b', requiredScope: 's' }] })!
    expect(chooseRelayIssuer(two, WORK)?.audience).toBe('b')
    expect(chooseRelayIssuer(two, '')).toBeNull()
  })

  it('reads a PSK-only relay, which omits every OIDC field', () => {
    const config = parseRelayAuthConfig({ oidc: false, psk: true, capabilities: { mobileForwardAck: true } })
    expect(config).toEqual({ oidc: false, psk: true, issuer: '', audience: '', requiredScope: '' })
    expect(relayIssuers(config!)).toEqual([])
  })

  it('rejects a malformed body rather than guessing', () => {
    expect(parseRelayAuthConfig(null)).toBeNull()
    expect(parseRelayAuthConfig({ oidc: 'yes', psk: true })).toBeNull()
    expect(parseRelayAuthConfig({ oidc: true, psk: false, issuers: [{ issuer: HOME }] })).toBeNull()
  })
})
