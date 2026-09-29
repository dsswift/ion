import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHealth, type HealthHandle } from '../health'
import { authPairRoute } from '../auth-pair'
import { CredentialsStore } from '../../auth/credentials-store'
import { createPairingLink, _resetPairingLinksForTest, type PairingAdvertise } from '../../auth/pairing-links'
import { _resetBearerJwksCacheForTest } from '../../auth/bearer'
import { startJwksFixture, signToken, type JwksFixture } from '../../auth/__tests__/jwks-fixture'
import type { ServerOidcConfig } from '../../config/server-config'
import { generateKeyPair } from '../../remote/crypto'

// A person who signs in to this server in a browser must pair their phone as
// themselves. Without the accompanying bearer an isolated server makes the
// phone its own principal, and it sees none of that person's conversations.

const ADVERTISE: PairingAdvertise = { url: 'http://server.example.org:7331', label: 'Example Server' }
const AUDIENCE = 'api://studio-server'

let health: HealthHandle
let dir: string
let store: CredentialsStore
let fixture: JwksFixture
let oidc: ServerOidcConfig | null

function oidcConfig(): ServerOidcConfig {
  return {
    issuer: fixture.issuer,
    audience: AUDIENCE,
    scope: 'Studio.Access',
    clientId: '',
    rolesToScopes: {},
    defaultScopes: ['conversations:read'],
    allowedSubjects: [],
    clientSecret: '',
  }
}

function baseUrl(h: HealthHandle): string {
  const address = h.tcpServer?.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo from the ephemeral TCP listener')
  return `http://127.0.0.1:${address.port}`
}

function mintLink(): string {
  const link = createPairingLink({ subject: 'owner', scopes: ['admin'] }, { scopes: ['conversations:read'] }, ['conversations:read'], ADVERTISE)
  if (!link.ok) throw new Error('unexpected refusal minting a link')
  return link.value.code
}

async function pair(code: string, authorization?: string): Promise<Response> {
  return fetch(`${baseUrl(health)}/auth/pair`, {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
    body: JSON.stringify({ code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'phone', kind: 'mobile', deviceId: 'phone-1' }),
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ion-auth-pair-bearer-test-'))
  store = new CredentialsStore(dir)
  fixture = await startJwksFixture()
  oidc = oidcConfig()
  _resetPairingLinksForTest()
  health = startHealth({ port: 0, routes: { '/auth/pair': authPairRoute(store, () => oidc) } })
})

afterEach(async () => {
  await health.close()
  _resetPairingLinksForTest()
  _resetBearerJwksCacheForTest()
  await fixture.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /auth/pair with an accompanying bearer', () => {
  it('pairs the device as the person the token names', async () => {
    const token = await signToken(fixture, { sub: 'person-sub', aud: AUDIENCE, scp: 'Studio.Access' })
    const res = await pair(mintLink(), `Bearer ${token}`)
    expect(res.status).toBe(200)
    const { clientId } = (await res.json()) as { clientId: string }
    expect(store.get(clientId)?.subject).toBe('person-sub')
  })

  it('refuses a token that does not verify, and leaves the code usable', async () => {
    const code = mintLink()
    const wrongAudience = await signToken(fixture, { sub: 'person-sub', aud: 'api://someone-else', scp: 'Studio.Access' })
    const refused = await pair(code, `Bearer ${wrongAudience}`)
    expect(refused.status).toBe(401)
    expect(((await refused.json()) as { error: string }).error).toBe('invalid_bearer')

    const good = await signToken(fixture, { sub: 'person-sub', aud: AUDIENCE, scp: 'Studio.Access' })
    const retried = await pair(code, `Bearer ${good}`)
    expect(retried.status).toBe(200)
    const { clientId } = (await retried.json()) as { clientId: string }
    expect(store.get(clientId)?.subject).toBe('person-sub')
  })

  it('refuses a token sent to a server with no identity provider rather than pairing anonymously', async () => {
    oidc = null
    const token = await signToken(fixture, { sub: 'person-sub', aud: AUDIENCE, scp: 'Studio.Access' })
    const res = await pair(mintLink(), `Bearer ${token}`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('bearer_unverifiable')
    expect(store.list()).toHaveLength(0)
  })

  it('pairs without a token exactly as before', async () => {
    const res = await pair(mintLink())
    expect(res.status).toBe(200)
    const { clientId } = (await res.json()) as { clientId: string }
    expect(store.get(clientId)?.subject).not.toBe('person-sub')
  })
})
