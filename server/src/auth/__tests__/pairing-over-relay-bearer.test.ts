/**
 * A pair_request on a relay channel honors an accompanying bearer the same
 * way POST /auth/pair does: the device pairs as the person the token names,
 * and a token that does not verify refuses without spending the code.
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
vi.mock('../../persistence/settings-store', () => ({ readSettings: () => ({}) }))

import { generateKeyPair } from '@ion/shared/e2e'
import { createPairingChannel, _resetPairingChannelsForTest } from '../pairing-channels'
import { createPairingLink, _resetPairingLinksForTest } from '../pairing-links'
import { credentialsStore, _resetCredentialsStoreForTest } from '../credentials-store'
import { _resetBearerJwksCacheForTest } from '../bearer'
import { startJwksFixture, signToken, type JwksFixture } from './jwks-fixture'
import type { ServerOidcConfig } from '../../config/server-config'

const AUDIENCE = 'api://studio-server'
let dataDir: string
let fixture: JwksFixture

function oidcConfig(): ServerOidcConfig {
  return { issuer: fixture.issuer, audience: AUDIENCE, scope: 'Studio.Access', clientId: '', rolesToScopes: {}, defaultScopes: ['conversations:read'], allowedSubjects: [], clientSecret: '' }
}

function mintCode(): string {
  const minted = createPairingLink({ subject: 'local', scopes: ['admin'] }, {}, ['conversations:read'], { url: 'http://h:7331', label: 'H' })
  if (!minted.ok) throw new Error('mint failed')
  return minted.value.code
}

async function reply(relay: FakeRelayClient, index: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100 && relay.sent.length <= index; i++) await new Promise((r) => setTimeout(r, 10))
  return relay.sent[index] as Record<string, unknown>
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ion-pair-relay-bearer-'))
  _resetCredentialsStoreForTest(dataDir)
  fixture = await startJwksFixture()
})
afterEach(async () => {
  _resetPairingChannelsForTest()
  _resetPairingLinksForTest()
  _resetBearerJwksCacheForTest()
  fakeClients.length = 0
  await fixture.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('pairing over a relay channel with a bearer', () => {
  it('pairs the device as the person the token names', async () => {
    const code = mintCode()
    createPairingChannel('wss://relay.example', 'psk-1', { getOidc: oidcConfig })
    const relay = fakeClients[0]
    const bearer = await signToken(fixture, { sub: 'person-sub', aud: AUDIENCE, scp: 'Studio.Access' })
    relay.emit('message', { type: 'pair_request', code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'phone', kind: 'mobile', bearer })
    const response = await reply(relay, 0)
    expect(response.ok).toBe(true)
    expect(credentialsStore().get(response.clientId as string)?.subject).toBe('person-sub')
  })

  it('refuses a token that does not verify and leaves the code unspent', async () => {
    const code = mintCode()
    createPairingChannel('wss://relay.example', 'psk-1', { getOidc: oidcConfig })
    const relay = fakeClients[0]
    const wrong = await signToken(fixture, { sub: 'person-sub', aud: 'api://someone-else', scp: 'Studio.Access' })
    relay.emit('message', { type: 'pair_request', code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'phone', kind: 'mobile', bearer: wrong })
    expect(await reply(relay, 0)).toEqual({ type: 'pair_response', ok: false, error: 'invalid_bearer' })
    expect(credentialsStore().list()).toHaveLength(0)

    const good = await signToken(fixture, { sub: 'person-sub', aud: AUDIENCE, scp: 'Studio.Access' })
    relay.emit('message', { type: 'pair_request', code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'phone', kind: 'mobile', bearer: good })
    expect((await reply(relay, 1)).ok).toBe(true)
  })
})
