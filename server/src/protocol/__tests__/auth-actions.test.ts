/**
 * End-to-end `studio_action` coverage of the `auth.*` action registry
 * (manifest requirement: "Actions (admin scope): auth.createPairingLink,
 * auth.listClients, auth.revokeClient, auth.createPairingChannel,
 * auth.cancelPairingChannel") over a real local Studio wire connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes, createHmac } from 'crypto'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../../state', () => ({ engineBridge: { connected: true }, deviceFocusMap: new Map(), state: { remoteTransport: null } }))

const fakeRelayClients: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
vi.mock('../../remote/relay-client', async () => {
  const { EventEmitter } = await import('events')
  // A pairing channel subscribes to the client's 'message' events to run the
  // pair_request exchange, so the fake must be an emitter like the real one.
  class FakeRelayClient extends EventEmitter {
    connect = vi.fn()
    disconnect = vi.fn()
    send = vi.fn()
    constructor() {
      super()
      fakeRelayClients.push(this)
    }
  }
  return { RelayClient: FakeRelayClient }
})

import { startHarness, connectLocal, connectTcp, waitOpen, sendFrame, nextFrame, helloAndWelcome, closeSocket, resetConnectionRegistryForTest, type Harness } from './harness'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { _resetCredentialsStoreForTest, CredentialsStore, credentialsStore } from '../../auth/credentials-store'
import { _resetBrowserSessionStoreForTest, browserSessionStore } from '../../auth/browser-session-store'
import { _resetCurrentServerConfigForTest, setCurrentServerConfig, currentServerConfig } from '../../config/current'
import { _resetPairingLinksForTest } from '../../auth/pairing-links'
import { _resetPairingChannelsForTest } from '../../auth/pairing-channels'
import { _resetNonceForTest, currentNonce } from '../../auth/nonce'
import { DefaultAuthPolicy } from '../../auth/auth-policy'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-auth-actions-test-'))
  process.env.ION_DATA_DIR = dataDir
  _resetCredentialsStoreForTest(dataDir)
  _resetBrowserSessionStoreForTest(dataDir)
  _resetCurrentServerConfigForTest()
  _resetNonceForTest()
  setCurrentServerConfig({ ...currentServerConfig(), relays: [{ url: 'wss://relay.example.org', psk: 'test-psk' }] })
  fakeRelayClients.length = 0
  harness = await startHarness({ authPolicy: new DefaultAuthPolicy({ oidc: null, credentials: credentialsStore(), sessions: browserSessionStore() }) })
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  _resetPairingLinksForTest()
  _resetPairingChannelsForTest()
  _resetCurrentServerConfigForTest()
  _resetNonceForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

async function runAction(ws: Parameters<typeof sendFrame>[0], action: string, args: unknown[]): Promise<Extract<StudioFrame, { type: 'studio_action_result' }>> {
  sendFrame(ws, { type: 'studio_action', id: `id-${action}`, action, args })
  const frame = await nextFrame(ws)
  if (frame.type !== 'studio_action_result') throw new Error(`expected studio_action_result, got ${frame.type}`)
  return frame
}

describe('auth.* actions: admin scope required', () => {
  it('an admin (local) connection can call auth.listClients', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    await helloAndWelcome(ws, { credential: { kind: 'local' } })

    const result = await runAction(ws, 'auth.listClients', [])
    expect(result.ok).toBe(true)
    expect(result.value).toEqual([])
    await closeSocket(ws)
  })

  it('a non-admin (paired, scoped) connection is refused with scope', async () => {
    const store = new CredentialsStore(dataDir)
    const secret = randomBytes(32)
    store.add({ clientId: 'limited-client', secret, scopes: ['conversations:read'], subject: 'paired:limited-client', kind: 'desktop' })
    const proof = createHmac('sha256', secret).update(Buffer.from(currentNonce(), 'base64url')).digest('base64')
    // This test is about scope, not transport: admit the paired client on a
    // plain socket rather than sealing every frame (`sealed-tcp.test.ts`
    // covers the sealed path and the refusal this setting turns off).
    const config = currentServerConfig()
    setCurrentServerConfig({ ...config, listen: { ...config.listen, tcp: { ...config.listen.tcp, allowUnsealedPaired: true } } })

    const ws = connectTcp(harness)
    await waitOpen(ws)
    const welcome = await helloAndWelcome(ws, { credential: { kind: 'paired', clientId: 'limited-client', proof } })
    expect(welcome.scopes).toEqual(['conversations:read'])

    const result = await runAction(ws, 'auth.listClients', [])
    expect(result.ok).toBe(false)
    expect(result.refusal).toEqual({ code: 'scope', message: 'auth.listClients requires scope admin' })

    await closeSocket(ws)
  })
})

describe('auth.createOwnPairingLink over the wire', () => {
  it('a non-admin connection mints a link for its own device where auth.createPairingLink is refused', async () => {
    const store = new CredentialsStore(dataDir)
    const secret = randomBytes(32)
    store.add({ clientId: 'person-client', secret, scopes: ['conversations:read', 'git:write'], subject: 'person-sub', kind: 'desktop' })
    const proof = createHmac('sha256', secret).update(Buffer.from(currentNonce(), 'base64url')).digest('base64')
    const config = currentServerConfig()
    setCurrentServerConfig({ ...config, tenancy: { mode: 'isolated' }, listen: { ...config.listen, tcp: { ...config.listen.tcp, allowUnsealedPaired: true } } })

    const ws = connectTcp(harness)
    await waitOpen(ws)
    await helloAndWelcome(ws, { credential: { kind: 'paired', clientId: 'person-client', proof } })

    expect(await runAction(ws, 'auth.createPairingLink', [{ label: 'Phone' }])).toMatchObject({ ok: false, refusal: { code: 'scope' } })
    const own = await runAction(ws, 'auth.createOwnPairingLink', [{ label: 'Phone' }])
    expect(own.ok).toBe(true)
    expect((own.value as { code: string }).code).toMatch(/^[0-9a-f]{32}$/)
    await closeSocket(ws)
  })
})

describe('auth.createPairingLink: --as', () => {
  it('names the human on an isolated install and is refused on a shared one', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    await helloAndWelcome(ws, { credential: { kind: 'local' } })

    const isolated = await runAction(ws, 'auth.createPairingLink', [{ label: 'bob laptop', as: 'bob' }])
    expect(isolated.ok).toBe(true)
    const { completePairing } = await import('../../auth/pairing-links')
    const { generateKeyPair } = await import('../../remote/crypto')
    const store = new CredentialsStore(dataDir)
    const completion = completePairing(store, { code: (isolated.value as { code: string }).code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'bob laptop', kind: 'desktop', deviceId: 'dev-1' })
    expect(completion.ok).toBe(true)
    if (completion.ok) expect(store.get(completion.clientId)?.subject).toBe('user:bob')

    expect(await runAction(ws, 'auth.createPairingLink', [{ as: 'user:bob' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })

    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
    expect(await runAction(ws, 'auth.createPairingLink', [{ as: 'bob' }])).toMatchObject({ ok: false, error: { code: 'shared_tenancy' } })
    closeSocket(ws)
  })
})

describe('auth.createPairingLink / auth.listClients / auth.revokeClient', () => {
  it('creates a pairing link with default scopes, then completing it registers a client listClients/revokeClient can see', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    await helloAndWelcome(ws, { credential: { kind: 'local' } })

    const created = await runAction(ws, 'auth.createPairingLink', [{ label: 'My laptop' }])
    expect(created.ok).toBe(true)
    const value = created.value as { url: string; code: string; expiresAt: number }
    expect(value.code).toMatch(/^[0-9a-f]{32}$/)

    const { completePairing } = await import('../../auth/pairing-links')
    const { generateKeyPair } = await import('../../remote/crypto')
    const store = new CredentialsStore(dataDir)
    const peerKeyPair = generateKeyPair()
    const completion = completePairing(store, { code: value.code, peerPublicKey: peerKeyPair.publicKey.toString('base64'), label: 'My laptop', kind: 'desktop' })
    expect(completion.ok).toBe(true)

    const listed = await runAction(ws, 'auth.listClients', [])
    expect(listed.ok).toBe(true)
    const clients = listed.value as { clientId: string; secretRef?: string }[]
    expect(clients).toHaveLength(1)
    expect(clients[0]).not.toHaveProperty('secretRef')

    const revoked = await runAction(ws, 'auth.revokeClient', [{ clientId: clients[0].clientId }])
    expect(revoked.ok).toBe(true)
    expect(revoked.value).toEqual({ revoked: true, closed: 0 })

    await closeSocket(ws)
  })
})

describe('auth.createPairingChannel / auth.cancelPairingChannel', () => {
  it('creates and cancels a relay pairing channel without a real network connection', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    await helloAndWelcome(ws, { credential: { kind: 'local' } })

    const created = await runAction(ws, 'auth.createPairingChannel', [{ relayUrl: 'wss://relay.example.org' }])
    expect(created.ok).toBe(true)
    const value = created.value as { channelId: string; expiresAt: number }
    expect(value.channelId).toMatch(/^pairing:[0-9a-f]{32}$/)
    expect(fakeRelayClients).toHaveLength(1)
    expect(fakeRelayClients[0].connect).toHaveBeenCalledOnce()

    const cancelled = await runAction(ws, 'auth.cancelPairingChannel', [{ channelId: value.channelId }])
    expect(cancelled.ok).toBe(true)
    expect(cancelled.value).toEqual({ cancelled: true })
    expect(fakeRelayClients[0].disconnect).toHaveBeenCalledOnce()

    await closeSocket(ws)
  })

  it('refuses an unconfigured relayUrl', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    await helloAndWelcome(ws, { credential: { kind: 'local' } })

    const result = await runAction(ws, 'auth.createPairingChannel', [{ relayUrl: 'wss://not-configured.example.org' }])
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('unknown_relay')

    await closeSocket(ws)
  })
})

describe('auth.revokeClient guards', () => {
  it('refuses to revoke the pairing the calling connection rides, and closes live sessions of a revoked one', async () => {
    const { AUTH_ACTIONS } = await import('../../auth/actions')
    const { connectionRegistry } = await import('../connection')
    const closed: string[] = []
    const live = { id: 'live-1', clientId: 'victim', isClosed: false, scopes: ['admin'], principal: null, close: (reason: string) => { closed.push(reason) } } as unknown as import('../connection').Connection
    connectionRegistry.add(live)
    try {
      const self = { id: 'c', clientId: 'me', scopes: ['admin'], principal: { subject: 'paired:me', displayName: 'me' }, send: () => true } as unknown as import('../connection').Connection
      const refused = await AUTH_ACTIONS['auth.revokeClient'].handler(self, [{ clientId: 'me' }])
      expect(refused).toMatchObject({ ok: false, refusal: { code: 'self' } })
      // The deliberate form is allowed: a headless client cleaning up after itself.
      const deliberate = await AUTH_ACTIONS['auth.revokeClient'].handler(self, [{ clientId: 'me', self: true }])
      expect(deliberate).toMatchObject({ ok: true })
      const out = await AUTH_ACTIONS['auth.revokeClient'].handler(self, [{ clientId: 'victim' }])
      expect(out).toMatchObject({ ok: true, value: { closed: 1 } })
      // The result is answered before the socket goes: the close lands a tick later.
      expect(closed).toEqual([])
      await new Promise((r) => setImmediate(r))
      expect(closed).toEqual(['revoked'])
    } finally {
      connectionRegistry.remove(live)
    }
  })
})
