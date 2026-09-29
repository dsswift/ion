import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHealth, type HealthHandle } from '../health'
import { authPairRoute } from '../auth-pair'
import { CredentialsStore } from '../../auth/credentials-store'
import { createPairingLink, _resetPairingLinksForTest, type PairingAdvertise } from '../../auth/pairing-links'

const ADVERTISE: PairingAdvertise = { url: 'http://server.example.org:7331', label: 'Example Server' }
import { generateKeyPair } from '../../remote/crypto'

let health: HealthHandle
let dir: string
let store: CredentialsStore

function baseUrl(h: HealthHandle): string {
  const address = h.tcpServer?.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo from the ephemeral TCP listener')
  return `http://127.0.0.1:${address.port}`
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-auth-pair-route-test-'))
  store = new CredentialsStore(dir)
  _resetPairingLinksForTest()
  health = startHealth({ port: 0, routes: { '/auth/pair': authPairRoute(store) } })
})

afterEach(async () => {
  await health.close()
  _resetPairingLinksForTest()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /auth/pair', () => {
  it('completes a valid pairing link and registers a client', async () => {
    const link = createPairingLink({ subject: 'josh', scopes: ['admin'] }, { scopes: ['conversations:read'] }, ['conversations:read'], ADVERTISE)
    if (!link.ok) throw new Error('unexpected refusal')

    const peerKeyPair = generateKeyPair()
    const res = await fetch(`${baseUrl(health)}/auth/pair`, {
      method: 'POST',
      body: JSON.stringify({ code: link.value.code, peerPublicKey: peerKeyPair.publicKey.toString('base64'), label: 'test device', kind: 'desktop' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.clientId).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof body.ourPublicKey).toBe('string')
    expect(body.scopes).toEqual(['conversations:read'])
    expect(store.get(body.clientId)).toBeDefined()
  })

  it('keeps who the device said it is signed in as, and drops a malformed identity', async () => {
    const pair = async (relayIdentity: unknown): Promise<string> => {
      const link = createPairingLink({ subject: 'owner', scopes: ['admin'] }, { scopes: ['conversations:read'] }, ['conversations:read'], ADVERTISE)
      if (!link.ok) throw new Error('unexpected refusal')
      const res = await fetch(`${baseUrl(health)}/auth/pair`, {
        method: 'POST',
        body: JSON.stringify({ code: link.value.code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'laptop', kind: 'desktop', relayIdentity }),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { clientId: string }).clientId
    }
    const identity = { issuer: 'https://login.example.org/home-tenant/v2.0', subject: 'oid-home' }
    expect(store.get(await pair(identity))?.relayIdentity).toEqual(identity)
    expect(store.get(await pair({ issuer: 'https://login.example.org/home-tenant/v2.0' }))?.relayIdentity).toBeUndefined()
  })

  it('refuses an unknown code with 410', async () => {
    const peerKeyPair = generateKeyPair()
    const res = await fetch(`${baseUrl(health)}/auth/pair`, {
      method: 'POST',
      body: JSON.stringify({ code: 'does-not-exist', peerPublicKey: peerKeyPair.publicKey.toString('base64'), label: '', kind: 'desktop' }),
    })
    expect(res.status).toBe(410)
    expect((await res.json()).error).toBe('not_found')
  })

  it('refuses a request missing required fields with 400', async () => {
    const res = await fetch(`${baseUrl(health)}/auth/pair`, { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(400)
  })

  it('refuses a non-POST method with 405', async () => {
    const res = await fetch(`${baseUrl(health)}/auth/pair`, { method: 'GET' })
    expect(res.status).toBe(405)
  })
})
