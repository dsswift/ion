/**
 * relay-listener -- a Studio connection fed by a relay channel.
 *
 * The RelayConnectionSocket opens sealed envelopes into plaintext frames and
 * seals replies; a hello sealed with a paired client's secret is admitted
 * with a welcome (the secret is the proof, no nonce), a hello naming
 * another clientId on that channel is refused, and a revoked client's
 * channel is closed on reconcile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../../state', () => ({
  engineBridge: { connected: true },
  deviceFocusMap: new Map(),
  state: { remoteTransport: null },
}))

const { fakeRelays, FakeRelayClient } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require('events') as typeof import('events')
  const relays: FakeRelayClient[] = []
  class FakeRelayClient extends Emitter {
    sent: unknown[] = []
    options: { relayUrl: string; channelId: string; apiKey: string }
    connect = vi.fn(() => { queueMicrotask(() => this.emit('connected')) })
    disconnect = vi.fn()
    send(message: unknown): void { this.sent.push(message) }
    constructor(options: { relayUrl: string; channelId: string; apiKey: string }) {
      super()
      this.options = options
      relays.push(this)
    }
  }
  return { fakeRelays: relays, FakeRelayClient }
})
type FakeRelayClient = InstanceType<typeof FakeRelayClient>
vi.mock('../../remote/relay-client', () => ({ RelayClient: FakeRelayClient }))

// Pass-through spy: the relay's push-failed notice is only observable in the log.
vi.mock('../../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger')>()
  return { ...actual, warn: vi.fn(actual.warn) }
})

const legacyPairedDeviceIds = vi.hoisted(() => new Set<string>())
vi.mock('../../remote/paired-device-lookup', () => ({ getPairedDeviceById: (id: string) => (legacyPairedDeviceIds.has(id) ? { id } : null) }))

import { sealRelayFrame, openRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import { deriveChannelId } from '@ion/shared/e2e'
import { encodeFrame, decodeFrame } from '@ion/shared/studio-wire/codec'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import { RelayConnectionSocket, startRelayStudioListeners, refreshRelayStudioClients, type RelayStudioListenersHandle } from '../relay-listener'
import { resolveStudioListenerOptions } from '../listener'
import { connectionRegistry } from '../connection'
import { credentialsStore, _resetCredentialsStoreForTest } from '../../auth/credentials-store'
import { _resetPrincipalRegistryForTest } from '../../identity/principal-registry'
import { LocalOnlyAuthPolicy } from '../hello'
import { ringOfflineThinClients } from '../../thin-view/push-doorbell'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../config/current'
import { defaultServerConfig } from '../../config/server-config'
import { warn as loggerWarn } from '../../logger'
import { registerTabOwner, _resetPrincipalIndexForTest } from '../tabs-index'

let dataDir: string
let originalIonDataDir: string | undefined
let handle: RelayStudioListenersHandle | null = null
const secret = Buffer.alloc(32, 9)

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-relay-listener-'))
  process.env.ION_DATA_DIR = dataDir
  _resetCredentialsStoreForTest(dataDir)
  fakeRelays.length = 0
  legacyPairedDeviceIds.clear()
})

afterEach(() => {
  handle?.close()
  handle = null
  for (const conn of connectionRegistry.all()) connectionRegistry.remove(conn)
  _resetPrincipalRegistryForTest()
  _resetCurrentServerConfigForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function listenerOptions() {
  return resolveStudioListenerOptions({ environmentId: 'env-relay', label: 'Relay Env', serverVersion: '0.0.0', authPolicy: new LocalOnlyAuthPolicy() })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('RelayConnectionSocket', () => {
  it('opens inbound envelopes into frames and seals outbound frames, text and binary alike', async () => {
    const relay = new FakeRelayClient({ relayUrl: 'wss://r', channelId: 'c', apiKey: 'k' })
    const socket = new RelayConnectionSocket(relay as never, secret, 'client-1')
    const received: Array<{ text: string; isBinary: boolean }> = []
    socket.on('message', (data, isBinary) => received.push({ text: data.toString(), isBinary }))

    relay.emit('message', JSON.parse(sealRelayFrame('{"hello":1}', secret)))
    relay.emit('message', JSON.parse(sealRelayFrame(new Uint8Array([1, 2, 3]), secret)))
    relay.emit('message', { v: 1, nonce: 'bad', ciphertext: 'bad' })
    relay.emit('message', { seq: 1, type: 'not-an-envelope' })
    expect(received).toEqual([{ text: '{"hello":1}', isBinary: false }, { text: '', isBinary: true }])

    socket.send('{"reply":true}')
    socket.send(Buffer.from([7, 8]))
    const opened = relay.sent.map((m) => openRelayFrame(JSON.stringify(m), secret))
    expect(opened[0]).toEqual({ bytes: Buffer.from('{"reply":true}'), isBinary: false })
    expect(opened[1]).toEqual({ bytes: Buffer.from([7, 8]), isBinary: true })

    const pong = vi.fn()
    socket.on('pong', pong)
    socket.ping()
    await settle()
    expect(pong).toHaveBeenCalled()

    const closed = vi.fn()
    socket.on('close', closed)
    relay.emit('disconnected')
    expect(closed).toHaveBeenCalledWith(1006, expect.any(Buffer))
  })
})

describe('startRelayStudioListeners', () => {
  it('opens one channel per paired desktop client on each relay, keyed by the client secret, and admits a sealed hello', async () => {
    const store = credentialsStore()
    const record = store.add({ clientId: 'client-a', secret, scopes: ['conversations:read'], subject: 'paired:client-a', kind: 'desktop' })

    // The relay was added to the server after this client paired.
    setCurrentServerConfig({ ...defaultServerConfig(), relays: [{ url: 'wss://relay.example', psk: 'psk-1' }] })
    handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })
    expect(handle.channelCount()).toBe(1)
    expect(fakeRelays).toHaveLength(1)
    expect(fakeRelays[0].options).toEqual({ relayUrl: 'wss://relay.example', apiKey: 'psk-1', channelId: deriveChannelId(secret) })
    await settle()

    const relay = fakeRelays[0]
    const hello = encodeFrame({ type: 'studio_hello', protocolVersion: PROTOCOL_VERSION, clientId: record.clientId, clientKind: 'desktop', capabilities: [], credential: { kind: 'paired', clientId: record.clientId, proof: 'channel' } })
    relay.emit('message', JSON.parse(sealRelayFrame(hello, secret)))
    await settle()

    const replies = relay.sent.map((m) => decodeFrame(openRelayFrame(JSON.stringify(m), secret)!.bytes.toString('utf-8')))
    expect(replies[0]).toMatchObject({ type: 'studio_welcome', environmentId: 'env-relay', principal: { subject: 'paired:client-a' }, scopes: ['conversations:read'] })
    // Every paired welcome says which relays the server is on, so a pairing
    // older than the relay learns of it without pairing again.
    expect((replies[0] as { relays?: unknown }).relays).toEqual([{ url: 'wss://relay.example', auth: { mode: 'psk', key: 'psk-1' } }])
    const conn = connectionRegistry.findByClientId(record.clientId)
    expect(conn?.transport).toBe('relay')
  })

  it('joins an OIDC relay with the operator\'s own tenant entry and announces the paired device\'s identity from another tenant', async () => {
    const HOME = 'https://login.example.org/home-tenant/v2.0'
    const WORK = 'https://login.example.org/work-tenant/v2.0'
    const store = credentialsStore()
    store.add({ clientId: 'client-a', secret, scopes: ['conversations:read'], subject: 'local:owner', kind: 'desktop', relayIdentity: { issuer: HOME, subject: 'oid-home' } })
    const requestToken = vi.fn((scope: string) => Promise.resolve({ ok: true, data: { accessToken: `token-for:${scope}`, expiresAt: Date.now() + 60_000 } }))

    handle = startRelayStudioListeners({
      relays: [{ url: 'wss://relay.example', psk: '', oidc: true }],
      listener: listenerOptions(),
      oidc: {
        probe: () => Promise.resolve({
          oidc: true, psk: false, issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access',
          issuers: [{ issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access' }, { issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' }],
        }),
        ownIssuer: () => Promise.resolve(WORK),
        requestToken,
      },
    })
    await settle()

    expect(fakeRelays).toHaveLength(1)
    const options = fakeRelays[0].options as unknown as { apiKey: string; channelId: string; announceTrust?: unknown; getCredential?: () => Promise<string> }
    expect(options.channelId).toBe(deriveChannelId(secret))
    expect(options.apiKey).toBe('')
    // The host signs in to the relay as itself (the work tenant)...
    await expect(options.getCredential!()).resolves.toBe('token-for:api://work-app/Relay.Access')
    // ...and tells the relay to admit the paired laptop's home-tenant subject.
    expect(options.announceTrust).toEqual({ issuer: HOME, audience: 'api://home-app', scope: 'Relay.Access', subject: 'oid-home' })
  })

  it('skips a relay that has neither a key nor OIDC, and an OIDC relay when no identity source was given', async () => {
    credentialsStore().add({ clientId: 'client-a', secret, scopes: ['conversations:read'], subject: 'paired:client-a', kind: 'desktop' })
    handle = startRelayStudioListeners({ relays: [{ url: 'wss://no-auth.example', psk: '' }, { url: 'wss://oidc.example', psk: '', oidc: true }], listener: listenerOptions() })
    await settle()
    expect(fakeRelays).toHaveLength(0)
    expect(handle.channelCount()).toBe(0)
  })

  it('opens a channel for a phone', async () => {
    const phoneSecret = Buffer.alloc(32, 1)
    credentialsStore().add({ clientId: 'phone', secret: phoneSecret, scopes: ['conversations:read'], subject: 'local:owner', kind: 'mobile' })
    handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })
    expect(handle.channelCount()).toBe(1)
    expect(fakeRelays[0].options.channelId).toBe(deriveChannelId(phoneSecret))
  })

  // Regression: a phone that migrated from the retired desktop_* wire still
  // has its `settings.pairedDevices` record, because the migration copies
  // rather than moves. This skipped exactly those phones -- the guard existed
  // so the two wires would not fight over one channel id, and outlived the
  // wire it was guarding against. Every migrated phone was left with no
  // channel, so off the LAN its hello went into a channel the server had
  // never joined and no welcome could come back.
  it('opens a channel for a migrated phone, which still has its old paired-device record', async () => {
    const phoneSecret = Buffer.alloc(32, 1)
    credentialsStore().add({ clientId: 'phone', secret: phoneSecret, scopes: ['conversations:read'], subject: 'local:owner', kind: 'mobile' })
    legacyPairedDeviceIds.add('phone')

    handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })

    expect(handle.channelCount()).toBe(1)
    expect(fakeRelays[0].options.channelId).toBe(deriveChannelId(phoneSecret))
  })

  // The client re-sends its hello every time it joins the channel. A second
  // hello landing on the already-welcomed Connection displaced that Connection
  // against itself, so any relay blip ended the session for good.
  it('gives each client join a fresh connection, and drops it when the client leaves', async () => {
    const store = credentialsStore()
    store.add({ clientId: 'client-a', secret, scopes: ['conversations:read'], subject: 'paired:client-a', kind: 'desktop' })
    handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })
    await settle()
    const relay = fakeRelays[0]
    const hello = (): unknown => JSON.parse(sealRelayFrame(encodeFrame({ type: 'studio_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client-a', clientKind: 'desktop', capabilities: [], credential: { kind: 'paired', clientId: 'client-a', proof: 'channel' } }), secret))
    const replies = (): string[] => relay.sent.map((m) => decodeFrame(openRelayFrame(JSON.stringify(m), secret)!.bytes.toString('utf-8')).type)

    relay.emit('message', hello())
    await settle()
    expect(replies()).toEqual(['studio_welcome'])
    const first = connectionRegistry.findByClientId('client-a')!

    relay.emit('control', { type: 'relay:peer-disconnected' })
    await settle()
    expect(connectionRegistry.findByClientId('client-a')).toBeUndefined()
    expect(first.isClosed).toBe(true)

    relay.sent.length = 0
    relay.emit('control', { type: 'relay:peer-reconnected' })
    relay.emit('message', hello())
    await settle()
    expect(replies()).toEqual(['studio_welcome'])
    expect(connectionRegistry.findByClientId('client-a')).not.toBe(first)
  })

  // A push the relay could not deliver (no push address yet, push not
  // configured, or Apple refused it) comes back as a control notice. It is
  // the server's only sign the push never reached the phone, so it is logged.
  it('logs a push the relay reports it could not deliver', async () => {
    const store = credentialsStore()
    store.add({ clientId: 'phone', secret, scopes: ['conversations:read'], subject: 'local:owner', kind: 'mobile' })
    handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })
    await settle()
    vi.mocked(loggerWarn).mockClear()
    fakeRelays[0].emit('control', { type: 'relay:push-failed', reason: 'no_token', resourceId: 'res-1' })
    expect(loggerWarn).toHaveBeenCalledWith('relay-listener', 'relay push failed', {
      client_id: 'phone', relay_url: 'wss://relay.example', reason: 'no_token', resource_id: 'res-1',
    })
  })

  describe('push doorbell', () => {
    const phoneSecret = Buffer.alloc(32, 1)
    const phoneToken = 'a'.repeat(64)
    const push = { pushTitle: 'Approval needed', pushBody: 'Bash wants to run', pushTabId: 'tab-1', notifyKind: 'permission' }

    beforeEach(() => {
      _resetPrincipalIndexForTest()
      registerTabOwner('tab-1', 'local:owner')
    })

    async function startWithPhoneAndDesktop(): Promise<{ phoneRelay: FakeRelayClient; desktopRelay: FakeRelayClient }> {
      const store = credentialsStore()
      store.add({ clientId: 'client-a', secret, scopes: ['conversations:read'], subject: 'local:owner', kind: 'desktop' })
      store.add({ clientId: 'phone', secret: phoneSecret, scopes: ['conversations:read'], subject: 'local:owner', kind: 'mobile' })
      store.setPushAddress('phone', { token: phoneToken, env: 'sandbox' })
      handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })
      await settle()
      const byChannel = (s: Buffer) => fakeRelays.find((r) => r.options.channelId === deriveChannelId(s))!
      return { phoneRelay: byChannel(phoneSecret), desktopRelay: byChannel(secret) }
    }

    it('rings an offline phone with a sealed doorbell, the push fields, and its own push address, and never a desktop', async () => {
      const { phoneRelay, desktopRelay } = await startWithPhoneAndDesktop()
      ringOfflineThinClients(push)

      expect(desktopRelay.sent).toEqual([])
      expect(phoneRelay.sent).toHaveLength(1)
      const envelope = phoneRelay.sent[0] as Record<string, unknown>
      expect(envelope).toMatchObject({ v: 1, push: true, ...push, pushToken: phoneToken, pushEnv: 'sandbox' })
      const doorbell = decodeFrame(openRelayFrame(JSON.stringify(envelope), phoneSecret)!.bytes.toString('utf-8'))
      expect(doorbell).toEqual({ type: 'studio_event', channel: 'studio:push-doorbell', payload: { tabId: 'tab-1' } })
    })

    it('does not ring a phone that is attached, on any transport', async () => {
      const { phoneRelay } = await startWithPhoneAndDesktop()
      const { Connection } = await import('../connection')
      const lan = new Connection({ send: vi.fn(), close: vi.fn(), terminate: vi.fn(), on: vi.fn(), ping: vi.fn() } as never, 'tcp')
      lan.pairedClientId = 'phone'
      connectionRegistry.add(lan)
      ringOfflineThinClients(push)
      expect(phoneRelay.sent).toEqual([])
    })

    it('does not ring a phone that has not registered a push address', async () => {
      const { phoneRelay } = await startWithPhoneAndDesktop()
      credentialsStore().setPushAddress('phone', null)
      ringOfflineThinClients(push)
      expect(phoneRelay.sent).toEqual([])
    })

    // Several people on one server: a conversation's push reaches every
    // device of the person who owns it and no one else's.
    describe('owner routing', () => {
      const myPad = Buffer.alloc(32, 3)
      const chrisPhone = Buffer.alloc(32, 4)

      async function startWithTwoPeople(): Promise<{ mine: FakeRelayClient[]; chris: FakeRelayClient }> {
        const store = credentialsStore()
        store.add({ clientId: 'phone', secret: phoneSecret, scopes: ['conversations:read'], subject: 'local:owner', kind: 'mobile' })
        store.add({ clientId: 'pad', secret: myPad, scopes: ['conversations:read'], subject: 'local:owner', kind: 'mobile' })
        store.add({ clientId: 'chris-phone', secret: chrisPhone, scopes: ['conversations:read'], subject: 'oidc:chris', kind: 'mobile' })
        for (const [id, fill] of [['phone', 'a'], ['pad', 'b'], ['chris-phone', 'c']] as const) {
          store.setPushAddress(id, { token: fill.repeat(64), env: 'production' })
        }
        handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })
        await settle()
        const byChannel = (s: Buffer) => fakeRelays.find((r) => r.options.channelId === deriveChannelId(s))!
        return { mine: [byChannel(phoneSecret), byChannel(myPad)], chris: byChannel(chrisPhone) }
      }

      it('rings every device of the conversation\'s owner and none of anyone else\'s', async () => {
        const { mine, chris } = await startWithTwoPeople()
        ringOfflineThinClients(push)
        expect(mine.map((relay) => relay.sent.length)).toEqual([1, 1])
        expect(mine.map((relay) => (relay.sent[0] as Record<string, unknown>).pushToken)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
        expect(chris.sent).toEqual([])

        registerTabOwner('tab-chris', 'oidc:chris')
        ringOfflineThinClients({ ...push, pushTabId: 'tab-chris' })
        expect(mine.map((relay) => relay.sent.length)).toEqual([1, 1])
        expect(chris.sent).toHaveLength(1)
      })

      it('rings everyone on a shared-tenancy server, where every conversation is everyone\'s', async () => {
        setCurrentServerConfig({ ...defaultServerConfig(), tenancy: { mode: 'shared' } })
        const { mine, chris } = await startWithTwoPeople()
        ringOfflineThinClients(push)
        expect([...mine, chris].map((relay) => relay.sent.length)).toEqual([1, 1, 1])
      })

      it('rings everyone for a push that names no conversation', async () => {
        const { mine, chris } = await startWithTwoPeople()
        ringOfflineThinClients({ pushTitle: 'New briefing ready', notifyKind: 'briefing' })
        expect([...mine, chris].map((relay) => relay.sent.length)).toEqual([1, 1, 1])
      })
    })

    it('does not ring a revoked phone, and stops ringing once the listener closes', async () => {
      const { phoneRelay } = await startWithPhoneAndDesktop()
      credentialsStore().revoke('phone')
      ringOfflineThinClients(push)
      expect(phoneRelay.sent).toEqual([])
      handle!.close()
      handle = null
      expect(() => ringOfflineThinClients(push)).not.toThrow()
      expect(phoneRelay.sent).toEqual([])
    })
  })

  it('refuses a hello that names a different clientId than the channel belongs to', async () => {
    const store = credentialsStore()
    store.add({ clientId: 'client-a', secret, scopes: ['conversations:read'], subject: 'paired:client-a', kind: 'desktop' })
    store.add({ clientId: 'client-b', secret: Buffer.alloc(32, 2), scopes: ['admin'], subject: 'paired:client-b', kind: 'desktop' })
    handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })
    await settle()
    const relayA = fakeRelays.find((r) => r.options.channelId === deriveChannelId(secret))!
    const hello = encodeFrame({ type: 'studio_hello', protocolVersion: PROTOCOL_VERSION, clientId: 'client-b', clientKind: 'desktop', capabilities: [], credential: { kind: 'paired', clientId: 'client-b', proof: 'channel' } })
    relayA.emit('message', JSON.parse(sealRelayFrame(hello, secret)))
    await settle()
    const reply = decodeFrame(openRelayFrame(JSON.stringify(relayA.sent[0]), secret)!.bytes.toString('utf-8'))
    expect(reply).toMatchObject({ type: 'studio_refused', reason: 'unauthorized' })
  })

  it('reconcile opens a channel for a newly paired client and closes a revoked one', async () => {
    const store = credentialsStore()
    handle = startRelayStudioListeners({ relays: [{ url: 'wss://relay.example', psk: 'psk-1' }], listener: listenerOptions() })
    expect(handle.channelCount()).toBe(0)
    store.add({ clientId: 'client-a', secret, scopes: ['admin'], subject: 'paired:client-a', kind: 'desktop' })
    refreshRelayStudioClients()
    expect(handle.channelCount()).toBe(1)
    store.revoke('client-a')
    refreshRelayStudioClients()
    expect(handle.channelCount()).toBe(0)
    expect(fakeRelays[0].disconnect).toHaveBeenCalled()
  })
})
