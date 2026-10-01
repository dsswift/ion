/**
 * pairing -- the desktop half of the pairing-link exchange, pinned against
 * the REAL server half: an http server here answers `POST /auth/pair` and
 * `GET /auth/config` by calling `@ion/server`'s own `completePairing` on a
 * real `CredentialsStore`, so the test proves both ends derive the same
 * secret and that the stored clientId is the one the server will look up.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../device-settings', () => ({ deviceId: () => 'device-test' }))
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import { createPairingLink, completePairing, _resetPairingLinksForTest } from '@ion/server/auth/pairing-links'
import { CredentialsStore } from '@ion/server/auth/credentials-store'
import { verifyPaired } from '@ion/server/auth/paired'
import { createAuthNonce } from '@ion/shared/e2e'
import { pairEnvironment } from '../pairing'
import { buildPairedCredential } from '../transport-tcp'
import { _setConnectionsFilePathForTest, loadCredential } from '../credentials'
import { decodePairedSecret } from '../paired-secret'

let dir: string
let store: CredentialsStore
let server: Server
let base: string
let nonce: string
const ENV_ID = 'env-11111111-2222-3333-4444-555555555555'

function readJson(req: import('http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>))
  })
}

const pairBodies: Record<string, unknown>[] = []
const pairAuthorization: (string | undefined)[] = []
const SIGN_IN = { issuer: 'https://login.example.org/tenant/v2.0', audience: 'server-app', scope: 'Studio.Access', clientId: 'sign-in-app' }
let offeredSignIn: typeof SIGN_IN | null = null

beforeEach(async () => {
  pairBodies.length = 0
  pairAuthorization.length = 0
  offeredSignIn = null
  dir = mkdtempSync(join(tmpdir(), 'ion-pairing-test-'))
  _setConnectionsFilePathForTest(join(dir, 'desktop-connections.json'))
  _resetPairingLinksForTest()
  store = new CredentialsStore(dir)
  nonce = createAuthNonce()
  server = createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/auth/config') {
      reply(200, { oidc: offeredSignIn, transports: ['local', 'paired'], environmentId: ENV_ID, label: 'Lab Server', protocolVersion: 1, serverVersion: '0.1.0', nonce })
      return
    }
    if (req.method === 'POST' && req.url === '/auth/pair') {
      pairAuthorization.push(req.headers.authorization)
      void readJson(req).then((body) => {
        pairBodies.push(body)
        const result = completePairing(store, { code: String(body.code), peerPublicKey: String(body.peerPublicKey), label: String(body.label ?? ''), kind: 'desktop' })
        if (!result.ok) { reply(410, { error: result.reason }); return }
        reply(200, { clientId: result.clientId, ourPublicKey: result.ourPublicKey, scopes: result.scopes })
      })
      return
    }
    reply(404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  _resetPairingLinksForTest()
  rmSync(dir, { recursive: true, force: true })
})

function mintLink(): string {
  const link = createPairingLink({ subject: 'admin', scopes: ['admin'] }, { label: 'x' }, ['conversations:read', 'conversations:operate'], { url: base, label: 'Lab Server' })
  if (!link.ok) throw new Error('mint failed')
  return link.value.url
}

describe('pairEnvironment', () => {
  it('completes the exchange, stores clientId + secret under the environment id, and returns a paired LAN target', async () => {
    const result = await pairEnvironment({ link: mintLink() }, 'desktop test')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.target).toEqual({ kind: 'paired', label: 'Lab Server', url: base, credentialRef: ENV_ID, via: 'lan', environmentId: ENV_ID })

    const stored = loadCredential(ENV_ID)
    expect(stored?.kind).toBe('paired')
    const secret = decodePairedSecret(stored!.plaintext)
    expect(secret).not.toBeNull()
    // The server registered exactly one client, under the clientId we stored.
    const clients = store.list()
    expect(clients).toHaveLength(1)
    expect(clients[0].clientId).toBe(secret!.clientId)
    expect(clients[0].scopes).toEqual(['conversations:read', 'conversations:operate'])
  })

  it('tells the server who this desktop is signed in as, and says nothing when it is signed out', async () => {
    const identity = { issuer: 'https://login.example.org/home-tenant/v2.0', subject: 'oid-home' }
    expect((await pairEnvironment({ link: mintLink() }, 'desktop test', identity)).ok).toBe(true)
    expect(pairBodies[0].relayIdentity).toEqual(identity)

    expect((await pairEnvironment({ link: mintLink() }, 'desktop test', null)).ok).toBe(true)
    expect('relayIdentity' in pairBodies[1]).toBe(false)
  })

  it('the stored secret produces a proof the server verifies (same secret on both ends)', async () => {
    const result = await pairEnvironment({ link: mintLink() }, 'desktop test')
    expect(result.ok).toBe(true)
    const secret = decodePairedSecret(loadCredential(ENV_ID)!.plaintext)!
    const credential = buildPairedCredential(secret.clientId, nonce, secret.sharedSecret)
    // The server checks against its rotating nonce set; a freshly minted test
    // nonce is not in it, so verify the HMAC directly with the shared primitive.
    const { verifyAuthProof } = await import('@ion/shared/e2e')
    expect(credential.kind).toBe('paired')
    if (credential.kind !== 'paired') return
    expect(verifyAuthProof(nonce, credential.proof, store.secretFor(secret.clientId)!)).toBe(true)
    // And the server's own verifier at least resolves the record by that clientId (refuses only on nonce mismatch, not unknown client).
    const verdict = await verifyPaired(credential, store)
    expect(verdict).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('prefers an explicit label over the link label', async () => {
    const result = await pairEnvironment({ link: mintLink(), label: 'Devbox' }, 'desktop test')
    expect(result.ok && result.target.label).toBe('Devbox')
  })

  it('explains a used link instead of throwing', async () => {
    const link = mintLink()
    expect((await pairEnvironment({ link }, 'a')).ok).toBe(true)
    const second = await pairEnvironment({ link }, 'b')
    expect(second).toMatchObject({ ok: false })
    if (second.ok) return
    expect(second.error).toMatch(/already used/)
  })

  it('refuses a malformed link before touching the network', async () => {
    const result = await pairEnvironment({ link: 'ion-studio://pair?code=zzz&url=http://x' }, 'a')
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toMatch(/malformed/)
  })

  it('reports an unreachable server', async () => {
    const link = createPairingLink({ subject: 'admin', scopes: ['admin'] }, {}, ['conversations:read'], { url: 'http://127.0.0.1:1', label: 'x' })
    if (!link.ok) throw new Error('mint failed')
    const result = await pairEnvironment({ link: link.value.url }, 'a')
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toMatch(/Could not reach/)
  })

  it('signs in and sends the token when the server offers sign-in', async () => {
    offeredSignIn = SIGN_IN
    const signIn = vi.fn(async () => 'person-token')
    expect((await pairEnvironment({ link: mintLink() }, 'desktop test', null, signIn)).ok).toBe(true)
    expect(signIn).toHaveBeenCalledWith(SIGN_IN)
    expect(pairAuthorization).toEqual(['Bearer person-token'])
    expect('bearer' in pairBodies[0]).toBe(false)
  })

  it('sends no token to a server that offers no sign-in', async () => {
    const signIn = vi.fn(async () => 'person-token')
    expect((await pairEnvironment({ link: mintLink() }, 'desktop test', null, signIn)).ok).toBe(true)
    expect(signIn).not.toHaveBeenCalled()
    expect(pairAuthorization).toEqual([undefined])
  })

  it('stops before spending the code when sign-in fails', async () => {
    offeredSignIn = SIGN_IN
    const result = await pairEnvironment({ link: mintLink() }, 'desktop test', null, async () => { throw new Error('signed out') })
    expect(result).toEqual({ ok: false, error: 'This server needs you to sign in before pairing: signed out' })
    expect(pairAuthorization).toEqual([])
  })
})
