/**
 * Pairing through a relay channel and the relay advertisement that rides
 * every pairing: a `pair_request` on a one-time channel completes the same
 * exchange `POST /auth/pair` runs and answers with the relays the client can
 * use afterward; the link names the channel; completion listeners fire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { fakeClients, FakeRelayClient } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require('events') as typeof import('events')
  const clients: FakeRelayClient[] = []
  class FakeRelayClient extends Emitter {
    sent: unknown[] = []
    connect = vi.fn()
    disconnect = vi.fn()
    send(message: unknown): void { this.sent.push(message) }
    constructor() { super(); clients.push(this) }
  }
  return { fakeClients: clients, FakeRelayClient }
})
type FakeRelayClient = InstanceType<typeof FakeRelayClient>
vi.mock('../../remote/relay-client', () => ({ RelayClient: FakeRelayClient }))

const settingsHolder: { settings: Record<string, unknown> } = { settings: {} }
vi.mock('../../persistence/settings-store', () => ({ readSettings: () => settingsHolder.settings }))

import { generateKeyPair, deriveSharedSecret } from '@ion/shared/e2e'
import { createPairingChannel, _resetPairingChannelsForTest, isPairingChannelActive } from '../pairing-channels'
import { createPairingLink, formatPairingLink, onPairingCompleted, completePairing, _resetPairingLinksForTest } from '../pairing-links'
import { credentialsStore, _resetCredentialsStoreForTest } from '../credentials-store'
import { effectiveRelays, advertisedRelays } from '../relay-advertise'
import { parsePairingLink } from '@ion/shared/pairing-link'
import type { ServerConfig } from '../../config/server-config'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ion-pair-relay-'))
  _resetCredentialsStoreForTest(dataDir)
  settingsHolder.settings = {}
})
afterEach(() => {
  _resetPairingChannelsForTest()
  _resetPairingLinksForTest()
  fakeClients.length = 0
  rmSync(dataDir, { recursive: true, force: true })
})

const caller = { subject: 'local', scopes: ['admin' as const] }

describe('pairing over a relay channel', () => {
  it('completes a pair_request with the same exchange as /auth/pair and advertises the relays', async () => {
    const minted = createPairingLink(caller, { label: 'laptop' }, ['conversations:read'], { url: 'http://h:7331', label: 'H' })
    if (!minted.ok) throw new Error('mint failed')
    const channel = createPairingChannel('wss://relay.example', 'psk-1', { advertisedRelays: () => [{ url: 'wss://relay.example', auth: { mode: 'psk', key: 'psk-1' } }] })
    const relay = fakeClients[0]
    const completed = vi.fn()
    onPairingCompleted(completed)

    const keys = generateKeyPair()
    relay.emit('message', { type: 'pair_request', code: minted.value.code, peerPublicKey: keys.publicKey.toString('base64'), label: 'laptop', kind: 'desktop', deviceId: 'dev-laptop' })
    const response = relay.sent[0] as { type: string; ok: boolean; clientId: string; ourPublicKey: string; relays: unknown[] }
    expect(response.type).toBe('pair_response')
    expect(response.ok).toBe(true)
    expect(response.relays).toEqual([{ url: 'wss://relay.example', auth: { mode: 'psk', key: 'psk-1' } }])

    // Both ends hold the same secret: the server's stored one decodes the
    // proof the desktop would compute from its own derivation.
    const desktopSecret = deriveSharedSecret(keys.secretKey, Buffer.from(response.ourPublicKey, 'base64'))
    expect(credentialsStore().secretFor(response.clientId)?.equals(desktopSecret)).toBe(true)
    // The label the client gave is kept, so a devices list can name the machine.
    expect(credentialsStore().get(response.clientId)?.label).toBe('laptop')
    // A device that names itself acts as one principal across re-pairings.
    expect(credentialsStore().get(response.clientId)?.subject).toBe('paired:dev-laptop')
    // The completion names the code it used, so the discovery window can tell its own code was spent.
    expect(completed).toHaveBeenCalledWith({ clientId: response.clientId, kind: 'desktop', code: minted.value.code })

    await new Promise((r) => setTimeout(r, 300))
    expect(isPairingChannelActive(channel.channelId)).toBe(false)
  })

  it('refuses a used code over the channel with the completion reason', () => {
    const minted = createPairingLink(caller, {}, ['conversations:read'], { url: 'http://h:7331', label: 'H' })
    if (!minted.ok) throw new Error('mint failed')
    const keys = generateKeyPair()
    expect(completePairing(credentialsStore(), { code: minted.value.code, peerPublicKey: keys.publicKey.toString('base64'), label: '', kind: 'desktop' }).ok).toBe(true)
    createPairingChannel('wss://relay.example', 'psk-1')
    const relay = fakeClients[0]
    relay.emit('message', { type: 'pair_request', code: minted.value.code, peerPublicKey: keys.publicKey.toString('base64'), label: '', kind: 'desktop' })
    expect(relay.sent[0]).toEqual({ type: 'pair_response', ok: false, error: 'used' })
  })
})

describe('pairing link relay parameters', () => {
  it('names the relay, channel, and key, and the shared parser reads them back', () => {
    const link = formatPairingLink('a'.repeat(32), { url: 'http://h:7331', label: 'H' }, { url: 'wss://relay.example', channel: 'b'.repeat(32), key: 'psk-1' })
    const parsed = parsePairingLink(link)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.link.relay).toEqual({ url: 'wss://relay.example', channel: 'b'.repeat(32), key: 'psk-1' })
    const plain = parsePairingLink(formatPairingLink('a'.repeat(32), { url: 'http://h:7331', label: 'H' }))
    expect(plain.ok && plain.link.relay).toBeUndefined()
  })
})

describe('effectiveRelays / advertisedRelays', () => {
  const base = { relays: [], oidc: null } as unknown as ServerConfig
  it('prefers server.json relays, falls back to the settings relay, and reads a keyless one as OIDC', () => {
    expect(effectiveRelays({ ...base, relays: [{ url: 'wss://a', psk: 'k' }] } as ServerConfig)).toEqual([{ url: 'wss://a', psk: 'k' }])
    settingsHolder.settings = { relayUrl: 'wss://desk', relayApiKey: 'dk' }
    expect(effectiveRelays(base)).toEqual([{ url: 'wss://desk', psk: 'dk' }])
    settingsHolder.settings = { relayUrl: 'wss://desk', relayApiKey: '' }
    expect(effectiveRelays(base)).toEqual([{ url: 'wss://desk', psk: '', oidc: true }])
  })

  // A configured URL is the whole signal now: the `remoteEnabled` toggle that
  // used to gate this is gone, so a relay is used because one was configured.
  it('falls back to no relay only when no url is configured', () => {
    settingsHolder.settings = { relayUrl: '', relayApiKey: 'dk' }
    expect(effectiveRelays(base)).toEqual([])
  })

  it('advertises psk auth without oidc and oidc auth with it', () => {
    const psk = { ...base, relays: [{ url: 'wss://a', psk: 'k' }] } as ServerConfig
    expect(advertisedRelays(psk)).toEqual([{ url: 'wss://a', auth: { mode: 'psk', key: 'k' } }])
    const oidc = { ...psk, oidc: { issuer: 'https://i', audience: 'aud', scope: 'Studio.Access' } } as unknown as ServerConfig
    expect(advertisedRelays(oidc)).toEqual([{ url: 'wss://a', auth: { mode: 'oidc', issuer: 'https://i', audience: 'aud', scope: 'Studio.Access' } }])
  })

  it('tells a paired client to sign in to an OIDC relay as itself', () => {
    const relayOidc = { ...base, relays: [{ url: 'wss://a', psk: '', oidc: true }] } as ServerConfig
    expect(advertisedRelays(relayOidc)).toEqual([{ url: 'wss://a', auth: { mode: 'relay-oidc' } }])
  })
})
