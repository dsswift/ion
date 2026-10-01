import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPairingLink, completePairing, _resetPairingLinksForTest, type PairingCaller, type PairingAdvertise } from '../pairing-links'

const ADVERTISE: PairingAdvertise = { url: 'http://server.example.org:7331', label: 'Example Server' }
import { CredentialsStore } from '../credentials-store'
import { generateKeyPair } from '../../remote/crypto'

let dir: string
let store: CredentialsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-pairing-links-test-'))
  store = new CredentialsStore(dir)
  _resetPairingLinksForTest()
})

afterEach(() => {
  _resetPairingLinksForTest()
  rmSync(dir, { recursive: true, force: true })
})

describe('createPairingLink: scope delegation', () => {
  it('refuses a request for a scope the caller does not have', () => {
    const caller: PairingCaller = { subject: 'josh', scopes: ['conversations:read', 'conversations:operate'] }
    const result = createPairingLink(caller, { scopes: ['git:write'] }, ['conversations:read'], ADVERTISE)
    expect(result).toMatchObject({ ok: false, refusal: 'scope' })
  })

  it('accepts a request for a scope subset of the caller scopes', () => {
    const caller: PairingCaller = { subject: 'josh', scopes: ['conversations:read', 'conversations:operate', 'git:write'] }
    const result = createPairingLink(caller, { scopes: ['conversations:read', 'git:write'] }, ['conversations:read'], ADVERTISE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.code).toMatch(/^[0-9a-f]{32}$/)
      expect(result.value.url).toContain(result.value.code)
      expect(result.value.expiresAt).toBeGreaterThan(Date.now())
    }
  })

  it('defaults to pairing.defaultScopes when no scopes are requested', () => {
    const caller: PairingCaller = { subject: 'josh', scopes: ['admin'] }
    const result = createPairingLink(caller, {}, ['conversations:read', 'terminal:operate'], ADVERTISE)
    expect(result.ok).toBe(true)
  })

  it('an admin caller may delegate any scope, including admin itself', () => {
    const caller: PairingCaller = { subject: 'josh', scopes: ['admin'] }
    const result = createPairingLink(caller, { scopes: ['admin', 'git:write'] }, ['conversations:read'], ADVERTISE)
    expect(result.ok).toBe(true)
  })
})

describe('completePairing', () => {
  it('completes a valid link, registering a client with the link scopes and marking the link used', async () => {
    const caller: PairingCaller = { subject: 'josh', scopes: ['admin'] }
    const link = createPairingLink(caller, { scopes: ['conversations:read', 'terminal:operate'], label: 'My laptop' }, ['conversations:read'], ADVERTISE)
    if (!link.ok) throw new Error('link creation unexpectedly refused')

    const peerKeyPair = generateKeyPair()
    const result = completePairing(store, { code: link.value.code, peerPublicKey: peerKeyPair.publicKey.toString('base64'), label: 'My laptop', kind: 'desktop' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.scopes).toEqual(['conversations:read', 'terminal:operate'])
      const record = store.get(result.clientId)
      expect(record).toBeDefined()
      expect(record?.scopes).toEqual(['conversations:read', 'terminal:operate'])
      expect(record?.kind).toBe('desktop')
    }

    // Single-use: a second completion attempt with the same code is refused.
    const second = completePairing(store, { code: link.value.code, peerPublicKey: peerKeyPair.publicKey.toString('base64'), label: 'My laptop', kind: 'desktop' })
    expect(second).toMatchObject({ ok: false, reason: 'used' })
  })

  it('refuses an unknown code', () => {
    const peerKeyPair = generateKeyPair()
    const result = completePairing(store, { code: 'not-a-real-code', peerPublicKey: peerKeyPair.publicKey.toString('base64'), label: '', kind: 'desktop' })
    expect(result).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

describe('createPairingLink: link carries the server address', () => {
  it('encodes code, advertised url, and server label as query parameters', () => {
    const caller: PairingCaller = { subject: 'josh', scopes: ['admin'] }
    const result = createPairingLink(caller, {}, ['conversations:read'], { url: 'http://devbox.local:7331', label: 'Devbox Lab' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = new URL(result.value.url)
    expect(parsed.protocol).toBe('ion-studio:')
    expect(parsed.host).toBe('pair')
    expect(parsed.searchParams.get('code')).toBe(result.value.code)
    expect(parsed.searchParams.get('url')).toBe('http://devbox.local:7331')
    expect(parsed.searchParams.get('env')).toBe('Devbox Lab')
  })
})

describe('completePairing: subject per tenancy', () => {
  it('a link minted --as names the human; two devices pairing through such links share user:<name>', () => {
    const caller: PairingCaller = { subject: 'admin', scopes: ['admin'] }
    const first = createPairingLink(caller, { as: 'bob', label: 'laptop' }, ['conversations:read'], ADVERTISE)
    const second = createPairingLink(caller, { as: 'bob', label: 'home' }, ['conversations:read'], ADVERTISE)
    if (!first.ok || !second.ok) throw new Error('link creation unexpectedly refused')
    const a = completePairing(store, { code: first.value.code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'laptop', kind: 'desktop', deviceId: 'dev-1' })
    const b = completePairing(store, { code: second.value.code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'home', kind: 'desktop', deviceId: 'dev-2' })
    if (!a.ok || !b.ok) throw new Error('pairing unexpectedly refused')
    expect(store.get(a.clientId)?.subject).toBe('user:bob')
    expect(store.get(b.clientId)?.subject).toBe('user:bob')
  })

  it('shared tenancy: the device acts as the host identity, ignoring the link\'s human', async () => {
    const { setCurrentServerConfig, currentServerConfig, _resetCurrentServerConfigForTest } = await import('../../config/current')
    const { userInfo } = await import('os')
    const link = createPairingLink({ subject: 'admin', scopes: ['admin'] }, { as: 'bob' }, ['conversations:read'], ADVERTISE)
    if (!link.ok) throw new Error('link creation unexpectedly refused')
    try {
      setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
      const result = completePairing(store, { code: link.value.code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'laptop', kind: 'desktop', deviceId: 'dev-1' })
      if (!result.ok) throw new Error('pairing unexpectedly refused')
      expect(store.get(result.clientId)?.subject).toBe(`local:${userInfo().username}`)
    } finally {
      _resetCurrentServerConfigForTest()
    }
  })
})
