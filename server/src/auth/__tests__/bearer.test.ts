import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyBearer, providerFromIssuer, _resetBearerJwksCacheForTest } from '../bearer'
import { startJwksFixture, signToken, type JwksFixture } from './jwks-fixture'
import type { ServerOidcConfig } from '../../config/server-config'

let fixture: JwksFixture

function oidcConfig(overrides: Partial<ServerOidcConfig> = {}): ServerOidcConfig {
  return {
    issuer: fixture.issuer,
    audience: 'api://studio-server',
    scope: 'Studio.Access',
    clientId: '',
    rolesToScopes: { 'Studio.Admin': ['admin'], 'Studio.User': ['conversations:read', 'conversations:operate'] },
    defaultScopes: ['conversations:read'],
    allowedSubjects: [],
    clientSecret: '',
    ...overrides,
  }
}

beforeEach(async () => {
  fixture = await startJwksFixture()
})

afterEach(async () => {
  _resetBearerJwksCacheForTest()
  await fixture.close()
})

describe('verifyBearer: valid token', () => {
  it('accepts a valid token and maps roles to scopes via rolesToScopes', async () => {
    const token = await signToken(fixture, { sub: 'user-1', aud: 'api://studio-server', scp: 'Studio.Access', roles: ['Studio.Admin'] })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.principal.subject).toBe('user-1')
      // The fixture issuer is a bare 127.0.0.1 test server, not a real Entra
      // host -- providerFromIssuer derives the provider name from the
      // issuer's hostname, and only recognizes a *.microsoftonline.com host
      // as 'entra'. See the wrong-audience/wrong-issuer tests below for the
      // 'entra' recognition itself; this test pins the scope-mapping path.
      expect(result.principal.provider).toBe('127.0.0.1')
      expect(result.principal.kind).toBe('operator')
      expect(result.scopes).toEqual(['admin'])
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    }
  })

  it('falls back to defaultScopes when the roles claim maps to nothing', async () => {
    const token = await signToken(fixture, { sub: 'user-2', aud: 'api://studio-server', scp: 'Studio.Access', roles: ['Some.Unmapped.Role'] })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scopes).toEqual(['conversations:read'])
  })

  it('falls back to defaultScopes when the token has no roles claim at all', async () => {
    const token = await signToken(fixture, { sub: 'user-3', aud: 'api://studio-server', scp: 'Studio.Access' })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scopes).toEqual(['conversations:read'])
  })

  it('unions scopes across multiple roles', async () => {
    const token = await signToken(fixture, { sub: 'user-4', aud: 'api://studio-server', scp: 'Studio.Access', roles: ['Studio.User'] })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scopes.sort()).toEqual(['conversations:operate', 'conversations:read'])
  })
})

describe('providerFromIssuer', () => {
  it('recognizes a *.microsoftonline.com host as entra', () => {
    expect(providerFromIssuer('https://login.microsoftonline.com/tenant-id/v2.0')).toBe('entra')
  })
})

describe('verifyBearer: refusals', () => {
  it('refuses a wrong-audience token', async () => {
    const token = await signToken(fixture, { sub: 'user-1', aud: 'api://someone-else', scp: 'Studio.Access' })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig())
    expect(result).toMatchObject({ ok: false, reason: 'wrong_audience' })
  })

  it('refuses a wrong-issuer token', async () => {
    const token = await signToken(fixture, { sub: 'user-1', aud: 'api://studio-server', iss: 'https://not-the-configured-issuer.example.com', scp: 'Studio.Access' })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig())
    expect(result).toMatchObject({ ok: false, reason: 'wrong_issuer' })
  })

  it('refuses an expired token', async () => {
    const token = await signToken(fixture, { sub: 'user-1', aud: 'api://studio-server', scp: 'Studio.Access', expiresInSeconds: -60 })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig())
    expect(result).toMatchObject({ ok: false, reason: 'token_expired' })
  })

  it('refuses a token missing the required scp scope', async () => {
    const token = await signToken(fixture, { sub: 'user-1', aud: 'api://studio-server', scp: 'SomeOther.Scope' })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig())
    expect(result).toMatchObject({ ok: false, reason: 'scope' })
  })

  it('refuses a subject not present in a non-empty allowedSubjects', async () => {
    const token = await signToken(fixture, { sub: 'user-not-allowed', aud: 'api://studio-server', scp: 'Studio.Access' })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig({ allowedSubjects: ['user-1', 'user-2'] }))
    expect(result).toMatchObject({ ok: false, reason: 'unlisted_subject' })
  })

  it('accepts a subject present in a non-empty allowedSubjects', async () => {
    const token = await signToken(fixture, { sub: 'user-1', aud: 'api://studio-server', scp: 'Studio.Access' })
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig({ allowedSubjects: ['user-1', 'user-2'] }))
    expect(result.ok).toBe(true)
  })

  it('refuses with jwks_unavailable when the issuer is unreachable', async () => {
    const token = await signToken(fixture, { sub: 'user-1', aud: 'api://studio-server', scp: 'Studio.Access' })
    // Port 1 on loopback is not a listening HTTP server in any test environment.
    const result = await verifyBearer({ kind: 'bearer', token }, oidcConfig({ issuer: 'http://127.0.0.1:1' }))
    expect(result).toMatchObject({ ok: false, reason: 'jwks_unavailable' })
  })
})
