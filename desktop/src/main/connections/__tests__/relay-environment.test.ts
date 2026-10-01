/**
 * Relay-backed environments on the desktop (ADR-033):
 *  - a v2 paired-secret record round-trips the advertised relays and a v1
 *    record still decodes;
 *  - RelayStudioSocket seals what the broker sends and opens what arrives,
 *    against a real local WebSocket standing in for the relay;
 *  - pairing falls back to the link's relay channel when the LAN address is
 *    silent, and stores the relays the response advertises;
 *  - connectEnvironment dials tcp when the LAN answers, the relay when it
 *    does not, arms the return-to-LAN probe only on the relay, and reports
 *    the transport it chose.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'

vi.mock('../../device-settings', () => ({ deviceId: () => 'device-test' }))
// The TCP transport is stubbed: these cases are about which route and
// credential an attempt resolves, and a real dial at an example.org name
// only produces an unhandled DNS failure after the assertion has run.
vi.mock('../transport-tcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport-tcp')>()
  const stub = () => ({ on() {}, once() {}, close() {}, send() {}, readyState: 0, OPEN: 1 })
  return { ...actual, connectTcp: vi.fn(stub), connectSealedTcp: vi.fn(stub) }
})

vi.mock('../broker-instance', () => ({
  broker: { connect: vi.fn(), disconnect: vi.fn(), phaseOf: vi.fn(() => undefined as unknown), sendAction: vi.fn(async () => ({ accessToken: 'minted-oidc-token' })), onFrame: vi.fn(() => () => {}) },
}))
vi.mock('../ssh/ssh-tunnel-instance', () => ({
  sshTunnels: { ensure: vi.fn(), localPortOf: vi.fn(() => null), stop: vi.fn() },
}))

import { encodePairedSecret, decodePairedSecret } from '../paired-secret'
import { RelayStudioSocket, relayJoinUrl } from '../transport-relay'
import { sealRelayFrame, openRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import { generateKeyPair, deriveSharedSecret, deriveChannelId } from '@ion/shared/e2e'
import { pairEnvironment } from '../pairing'
import { connectEnvironment, disconnectEnvironment, rememberAdvertisedRelays, _lanReprobeArmedForTest } from '../environment-connect'
import { sshTunnels } from '../ssh/ssh-tunnel-instance'
import { broker } from '../broker-instance'
import { _setConnectionsFilePathForTest, saveCredential, loadCredential } from '../credentials'

const secret = Buffer.alloc(32, 5)
const relays = [{ url: 'wss://relay.example', auth: { mode: 'psk' as const, key: 'psk-1' } }]

describe('paired-secret v2', () => {
  it('round-trips relays and still decodes a v1 record', () => {
    const decoded = decodePairedSecret(encodePairedSecret({ clientId: 'c1', sharedSecret: secret, relays }))
    expect(decoded).toEqual({ clientId: 'c1', sharedSecret: secret, relays })
    const v1 = JSON.stringify({ v: 1, clientId: 'c1', sharedSecret: secret.toString('base64') })
    expect(decodePairedSecret(v1)).toEqual({ clientId: 'c1', sharedSecret: secret })
    const junkRelay = JSON.stringify({ v: 2, clientId: 'c1', sharedSecret: secret.toString('base64'), relays: [{ url: 'x' }] })
    expect(decodePairedSecret(junkRelay)?.relays).toBeUndefined()
  })
})

describe('RelayStudioSocket', () => {
  let server: WebSocketServer
  let base: string
  const seen: { url: string; auth: string | undefined; frames: string[] } = { url: '', auth: undefined, frames: [] }

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => server.once('listening', () => r()))
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
    seen.frames = []
    server.on('connection', (ws: WsSocket, req) => {
      seen.url = req.url ?? ''
      seen.auth = req.headers.authorization
      ws.on('message', (raw) => {
        seen.frames.push(raw.toString())
        // The "server" answers a sealed hello with a sealed welcome.
        ws.send(sealRelayFrame('{"type":"studio_welcome"}', secret))
        ws.send(sealRelayFrame(new Uint8Array([9, 9]), secret))
        ws.send('{"type":"relay:peer_connected"}')
      })
    })
  })
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())) })

  it('joins as the mobile role with the bearer, seals outbound frames, opens inbound ones, and ignores relay control frames', async () => {
    const socket = new RelayStudioSocket(base, deriveChannelId(secret), secret, 'psk-1')
    await new Promise<void>((r) => socket.once('open', () => r()))
    const received: Array<{ text: string; isBinary: boolean }> = []
    socket.on('message', (data, isBinary) => received.push({ text: String(data), isBinary }))
    socket.send('{"type":"studio_hello"}')
    await new Promise((r) => setTimeout(r, 50))
    expect(seen.url).toBe(relayJoinUrl(base, deriveChannelId(secret)).replace(base, ''))
    expect(seen.auth).toBe('Bearer psk-1')
    expect(openRelayFrame(seen.frames[0], secret)).toEqual({ bytes: Buffer.from('{"type":"studio_hello"}'), isBinary: false })
    expect(received).toEqual([{ text: '{"type":"studio_welcome"}', isBinary: false }, { text: '\t\t', isBinary: true }])
    expect(socket.readyState).toBe(socket.OPEN)
    socket.close()
  })
})

describe('pairEnvironment over a relay channel', () => {
  let server: WebSocketServer
  let base: string
  const originalFetch = globalThis.fetch
  let serverKeys: ReturnType<typeof generateKeyPair>
  let peerPublicKey = ''

  beforeEach(async () => {
    _setConnectionsFilePathForTest(join(mkdtempSync(join(tmpdir(), 'ion-relay-pair-')), 'desktop-connections.json'))
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => server.once('listening', () => r()))
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
    serverKeys = generateKeyPair()
    server.on('connection', (ws: WsSocket, req) => {
      expect(req.url).toBe(`/v1/channel/pairing:${'b'.repeat(32)}?role=mobile`)
      expect(req.headers.authorization).toBe('Bearer relay-key')
      ws.on('message', (raw) => {
        const request = JSON.parse(raw.toString()) as { type: string; code: string; peerPublicKey: string; deviceId?: string }
        expect(request.type).toBe('pair_request')
        expect(request.code).toBe('a'.repeat(32))
        // The desktop's stable id rides every pairing so the server keeps one record per desktop.
        expect(request.deviceId).toBe('device-test')
        peerPublicKey = request.peerPublicKey
        ws.send(JSON.stringify({ type: 'pair_response', ok: true, clientId: 'client-relay', ourPublicKey: serverKeys.publicKey.toString('base64'), scopes: ['admin'], relays }))
      })
    })
    // The LAN address is a black hole.
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('completes the exchange through the channel and stores the advertised relays under the clientId', async () => {
    const link = `ion-studio://pair?code=${'a'.repeat(32)}&url=http://10.0.0.9:7331&env=Lab&relay=${encodeURIComponent(base)}&channel=${'b'.repeat(32)}&relayKey=relay-key`
    const result = await pairEnvironment({ link }, 'desktop test')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.target).toMatchObject({ kind: 'paired', via: 'relay', url: 'http://10.0.0.9:7331', credentialRef: 'client-relay', relayUrls: ['wss://relay.example'] })
    const stored = loadCredential('client-relay')
    const decoded = decodePairedSecret(stored!.plaintext)!
    expect(decoded.clientId).toBe('client-relay')
    expect(decoded.relays).toEqual(relays)
    // Both ends derived the same secret: the server side from its own key
    // pair and the desktop's public key it received on the channel.
    expect(peerPublicKey).not.toBe('')
    expect(decoded.sharedSecret.equals(deriveSharedSecret(serverKeys.secretKey, Buffer.from(peerPublicKey, 'base64')))).toBe(true)
  })

  it('reports the LAN failure when the link names no relay', async () => {
    const result = await pairEnvironment({ link: `ion-studio://pair?code=${'a'.repeat(32)}&url=http://10.0.0.9:7331` }, 'desktop test')
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Could not reach http:\/\/10\.0\.0\.9:7331/) })
  })
})

describe('connectEnvironment route selection', () => {
  const originalFetch = globalThis.fetch
  const target = { kind: 'paired' as const, label: 'Lab', url: 'http://lab.example.org:7331', credentialRef: 'env-r', via: 'lan' as const, environmentId: 'env-r' }

  beforeEach(() => {
    _setConnectionsFilePathForTest(join(mkdtempSync(join(tmpdir(), 'ion-env-route-')), 'desktop-connections.json'))
    vi.mocked(broker.connect).mockClear()
    saveCredential('env-r', 'paired', encodePairedSecret({ clientId: 'c-r', sharedSecret: secret, relays }))
  })
  afterEach(() => {
    disconnectEnvironment('env-r')
    globalThis.fetch = originalFetch
  })

  it('dials tcp with a nonce proof when the LAN answers, and arms no reprobe', async () => {
    const nonce = Buffer.from('n').toString('base64')
    globalThis.fetch = (async () => new Response(JSON.stringify({ nonce, environmentId: 'env-r', label: 'Lab' }), { status: 200 })) as typeof fetch
    await connectEnvironment('env-r', 'Lab', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(attempt.transport).toBe('tcp')
    expect(_lanReprobeArmedForTest('env-r')).toBe(false)
  })

  it('falls back to the stored relay with the PSK when the LAN is silent, and arms the return-to-LAN probe', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    await connectEnvironment('env-r', 'Lab', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(attempt.transport).toBe('relay')
    expect(attempt.credential).toMatchObject({ kind: 'paired', clientId: 'c-r' })
    expect(_lanReprobeArmedForTest('env-r')).toBe(true)
    const socket = attempt.socket as RelayStudioSocket
    expect(socket).toBeInstanceOf(RelayStudioSocket)
    expect(socket.relayUrl).toBe('wss://relay.example')
    socket.close()
    disconnectEnvironment('env-r')
    expect(_lanReprobeArmedForTest('env-r')).toBe(false)
  })

  it('mints an OIDC token through the local server for an oidc relay', async () => {
    saveCredential('env-r', 'paired', encodePairedSecret({ clientId: 'c-r', sharedSecret: secret, relays: [{ url: 'wss://relay.example', auth: { mode: 'oidc', issuer: 'https://i', audience: 'aud', scope: 'Studio.Access' } }] }))
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    await connectEnvironment('env-r', 'Lab', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'oidc.token', [{ scope: 'Studio.Access', audience: 'aud' }])
    expect(attempt.transport).toBe('relay')
    attempt.socket.close()
  })

  it('signs in to a relay that lists several tenants with the entry for this desktop\'s own tenant', async () => {
    const HOME = 'https://login.example.org/home-tenant/v2.0'
    const WORK = 'https://login.example.org/work-tenant/v2.0'
    saveCredential('env-r', 'paired', encodePairedSecret({ clientId: 'c-r', sharedSecret: secret, relays: [{ url: 'wss://relay.example', auth: { mode: 'relay-oidc' } }] }))
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) !== 'https://relay.example/v1/auth/config') throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({
        oidc: true, psk: false, issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access',
        issuers: [{ issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' }, { issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access' }],
      }), { status: 200 })
    }) as typeof fetch
    vi.mocked(broker.sendAction).mockClear()
    vi.mocked(broker.sendAction).mockImplementation(async (_env: string, action: string) =>
      action === 'oidc.identity' ? { issuer: HOME, subject: 'oid-home' } : { accessToken: 'minted-oidc-token' })

    await connectEnvironment('env-r', 'Lab', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()

    // Not the relay's primary (work) entry: the one for the tenant this desktop is signed in to.
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'oidc.token', [{ scope: 'api://home-app/Relay.Access', audience: undefined }])
    expect(attempt.transport).toBe('relay')
    attempt.socket.close()
    vi.mocked(broker.sendAction).mockImplementation(async () => ({ accessToken: 'minted-oidc-token' }))
  })

  /**
   * A work server and a personal desktop: the server announces the identity
   * the desktop paired with, and the relay admits it. The desktop once
   * refused before asking, which left a paired server unreachable from any
   * other network. The relay decides; a join it does not admit claims nothing.
   */
  it('joins a relay channel from a different tenant than the server joins it with, as its own tenant', async () => {
    const HOME = 'https://login.example.org/home-tenant/v2.0'
    const WORK = 'https://login.example.org/work-tenant/v2.0'
    saveCredential('env-r', 'paired', encodePairedSecret({ clientId: 'c-r', sharedSecret: secret, relays: [{ url: 'wss://relay.example', auth: { mode: 'relay-oidc', issuer: WORK } }] }))
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) !== 'https://relay.example/v1/auth/config') throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({
        oidc: true, psk: false, issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access',
        issuers: [{ issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' }, { issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access' }],
      }), { status: 200 })
    }) as typeof fetch
    vi.mocked(broker.sendAction).mockClear()
    vi.mocked(broker.sendAction).mockImplementation(async (_env: string, action: string) =>
      action === 'oidc.identity' ? { issuer: HOME, subject: 'oid-home' } : { accessToken: 'minted-oidc-token' })

    await connectEnvironment('env-r', 'Lab', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()

    expect(broker.sendAction).toHaveBeenCalledWith('local', 'oidc.token', [{ scope: 'api://home-app/Relay.Access', audience: undefined }])
    expect(attempt.transport).toBe('relay')
    attempt.socket.close()
    vi.mocked(broker.sendAction).mockImplementation(async () => ({ accessToken: 'minted-oidc-token' }))
  })

  it('stores the relays a welcome reports, so a pairing older than the relay can fall back to it', async () => {
    saveCredential('env-r', 'paired', encodePairedSecret({ clientId: 'c-r', sharedSecret: secret }))
    const reported = [{ url: 'wss://later-relay.example', auth: { mode: 'psk' as const, key: 'later-key' } }]
    expect(rememberAdvertisedRelays('env-r', target, reported)).toBe(true)
    const stored = decodePairedSecret(loadCredential('env-r')!.plaintext)!
    expect(stored.relays).toEqual(reported)
    expect(stored.clientId).toBe('c-r')
    expect(stored.sharedSecret.equals(secret)).toBe(true)
    // Unchanged on the next welcome: nothing is rewritten.
    expect(rememberAdvertisedRelays('env-r', target, reported)).toBe(false)
    // A server that drops its relay is believed too.
    expect(rememberAdvertisedRelays('env-r', target, [])).toBe(true)
    expect(decodePairedSecret(loadCredential('env-r')!.plaintext)!.relays ?? []).toEqual([])
  })

  it('reaches an SSH-added host through its relay when the SSH forward cannot open, and says why when there is no relay', async () => {
    const sshTarget = { ...target, via: 'ssh' as const, ssh: { destination: 'me@lab.example.org', remotePort: 7331 } }
    vi.mocked(sshTunnels.ensure).mockRejectedValue(new Error('ssh: connect to host lab.example.org: Operation timed out'))
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch

    await connectEnvironment('env-r', 'Lab', sshTarget)
    const sshAttempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(sshAttempt.transport).toBe('relay')
    // The socket is the relay's, not a dial at the forward's local end: the
    // forward is exactly what could not open, so there is no port to dial.
    expect(sshAttempt.socket).toBeInstanceOf(RelayStudioSocket)
    sshAttempt.socket.close()
    expect(_lanReprobeArmedForTest('env-r')).toBe(true)
    disconnectEnvironment('env-r')

    saveCredential('env-r', 'paired', encodePairedSecret({ clientId: 'c-r', sharedSecret: secret }))
    await connectEnvironment('env-r', 'Lab', sshTarget)
    const attempt = vi.mocked(broker.connect).mock.calls.at(-1)![0].open()
    await expect(attempt).rejects.toThrow(/has reported no relay to fall back to/)
  })

  it('keeps a plain LAN pairing (no stored relays) on tcp without probing twice', async () => {
    saveCredential('env-r', 'paired', encodePairedSecret({ clientId: 'c-r', sharedSecret: secret }))
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => { calls.push(String(input)); return new Response(JSON.stringify({ nonce: 'bg==' }), { status: 200 }) }) as typeof fetch
    await connectEnvironment('env-r', 'Lab', target)
    expect((await vi.mocked(broker.connect).mock.calls[0][0].open()).transport).toBe('tcp')
    expect(calls).toEqual(['http://lab.example.org:7331/auth/config'])
  })
})

describe('RelayStudioSocket: a join the relay refuses', () => {
  const refusedWith = async (status: number): Promise<Error> => {
    const relay = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: (_info, done) => done(false, status, 'refused') })
    await new Promise<void>((resolve) => relay.once('listening', resolve))
    const url = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`
    try {
      const socket = new RelayStudioSocket(url, 'ab'.repeat(16), Buffer.alloc(32, 7), 'token')
      return await new Promise<Error>((resolve) => socket.once('error', resolve))
    } finally {
      relay.close()
    }
  }

  it('says a 403 is the channel not admitting this account, and what admits it', async () => {
    const err = await refusedWith(403)
    expect(err.message).toMatch(/HTTP 403/)
    expect(err.message).toMatch(/does not admit the account this desktop is signed in to/)
    expect(err.message).toMatch(/sign in to the server's tenant, or pair again/)
  })

  it('reports any other status bare', async () => {
    const err = await refusedWith(401)
    expect(err.message).toMatch(/refused the channel join: HTTP 401$/)
  })
})

/**
 * A server that restarts rejoins the channel with a new Connection that drops
 * every frame until it gets a hello. The desktop once only logged the relay's
 * notice and kept its old session, so every action went unanswered.
 */
describe('RelayStudioSocket: the server leaves or rejoins the channel', () => {
  const closedAfter = async (control: string): Promise<number> => {
    const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => relay.once('listening', resolve))
    relay.on('connection', (ws: WsSocket) => ws.send(JSON.stringify({ type: control })))
    try {
      const socket = new RelayStudioSocket(`ws://127.0.0.1:${(relay.address() as AddressInfo).port}`, 'ab'.repeat(16), Buffer.alloc(32, 7), 'token')
      return await new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
    } finally {
      relay.close()
    }
  }

  it('ends the session when the server rejoins, so the broker joins again and says hello', async () => {
    expect(await closedAfter('relay:peer-reconnected')).toBe(1006)
  })

  it('ends the session when the server leaves', async () => {
    expect(await closedAfter('relay:peer-disconnected')).toBe(1006)
  })
})
