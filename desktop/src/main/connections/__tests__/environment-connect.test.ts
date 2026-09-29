/**
 * environment-connect — credential/transport resolution and refusal
 * propagation for non-local environments (spec 13/12).
 *
 * Resolution belongs to the broker's per-attempt `open()`, never to the
 * `connectEnvironment` call: bearer with no sign-in configuration, and
 * relay/paired without a stored secret, refuse the ATTEMPT, so
 * the broker keeps the target and retries it instead of leaving the
 * environment with no connection to retry at all.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The TCP transport is stubbed: these cases are about which route and
// credential an attempt resolves, and a real dial at an example.org name
// only produces an unhandled DNS failure after the assertion has run.
vi.mock('../transport-tcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport-tcp')>()
  const stub = () => ({ on() {}, once() {}, close() {}, send() {}, readyState: 0, OPEN: 1 })
  return { ...actual, connectTcp: vi.fn(stub), connectSealedTcp: vi.fn(stub) }
})

// No server listens on the local socket in a test; a real dial there only
// raises an unhandled ENOENT after the assertion has run.
vi.mock('../transport-local', () => ({
  connectLocal: vi.fn(() => ({ on() {}, once() {}, close() {}, send() {}, readyState: 0, OPEN: 1 })),
}))

// A bearer token comes from the server's own sign-in (`server-bearer.ts`, tested on its own).
vi.mock('../server-bearer', () => ({ bearerTokenFor: vi.fn(async () => 'server-app-token') }))

vi.mock('../broker-instance', () => ({
  broker: { onFrame: vi.fn(() => () => {}), connect: vi.fn(), sendAction: vi.fn(), phaseOf: vi.fn(() => undefined as unknown), replayWelcome: vi.fn(() => true), replayPhase: vi.fn(() => true), restart: vi.fn() },
}))

import { connectEnvironment, renewRemoteEnvironmentsAfterWake } from '../environment-connect'
import { broker } from '../broker-instance'
import { bearerTokenFor } from '../server-bearer'
import { _setConnectionsFilePathForTest, saveCredential } from '../credentials'
import { encodePairedSecret } from '../paired-secret'
import { verifyAuthProof } from '@ion/shared/e2e'

describe('connectEnvironment', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ion-env-connect-'))
    _setConnectionsFilePathForTest(join(dir, 'desktop-connections.json'))
    vi.mocked(broker.connect).mockClear()
    vi.mocked(broker.phaseOf).mockReturnValue(undefined)
  })

  it('keeps a live local connection when asked to connect the local environment again, and replaces an offline one', async () => {
    vi.mocked(broker.phaseOf).mockReturnValue({ phase: 'connected', transport: 'local' })
    await connectEnvironment('local', 'This Mac', { kind: 'local' })
    expect(broker.connect).not.toHaveBeenCalled()
    // The window asking is newer than the kept connection's welcome, so it is
    // handed that welcome; otherwise it never learns what the server said.
    expect(broker.replayWelcome).toHaveBeenCalledWith('local', expect.any(String))
    // The phase rides with the welcome: the window's registry set `connecting` for itself and has no other way to learn the wire is up.
    expect(broker.replayPhase).toHaveBeenCalledWith('local')
    vi.mocked(broker.phaseOf).mockReturnValue({ phase: 'offline', transport: 'local', reason: 'test' })
    await connectEnvironment('local', 'This Mac', { kind: 'local' })
    expect(broker.connect).toHaveBeenCalledTimes(1)
  })

  it('redials every remote environment after a system wake, and never the local one', async () => {
    await connectEnvironment('local', 'This Mac', { kind: 'local' })
    await connectEnvironment('env-wake', 'Work Mac', { kind: 'paired', label: 'Work Mac', url: 'http://work.example.org:7331', credentialRef: 'env-wake', via: 'lan' })
    vi.mocked(broker.restart).mockClear()

    expect(renewRemoteEnvironmentsAfterWake()).toBeGreaterThanOrEqual(1)
    expect(broker.restart).toHaveBeenCalledWith('env-wake')
    expect(broker.restart).not.toHaveBeenCalledWith('local')
  })

  it('connects the local environment with a local credential, no stored secret needed', async () => {
    await connectEnvironment('local', 'This Mac', { kind: 'local' })
    expect(broker.connect).toHaveBeenCalledTimes(1)
    const target = vi.mocked(broker.connect).mock.calls[0][0]
    expect(target.transport).toBe('local')
    expect((await target.open()).credential).toEqual({ kind: 'local' })
    expect(target.capabilities).toEqual(['graph', 'browser', 'wire-ping'])
  })

  it('refuses the attempt for a bearer target with no sign-in configuration', async () => {
    await connectEnvironment('env-b', 'Team', { kind: 'bearer', label: 'Team', url: 'wss://team.example' })
    await expect(vi.mocked(broker.connect).mock.calls[0][0].open()).rejects.toThrow(/no sign-in configuration/)
  })

  it('connects a bearer target with a token from the server\'s own sign-in app', async () => {
    const oidc = { issuer: 'https://login.example.org/t/v2.0', audience: 'server-app', scope: 'Studio.Access', clientId: 'server-app' }
    await connectEnvironment('env-b', 'Team', { kind: 'bearer', label: 'Team', url: 'wss://team.example', oidc })
    expect(broker.connect).toHaveBeenCalledTimes(1)
    const target = vi.mocked(broker.connect).mock.calls[0][0]
    const attempt = await target.open()
    expect(bearerTokenFor).toHaveBeenCalledWith('env-b', oidc)
    expect(attempt.credential).toEqual({ kind: 'bearer', token: 'server-app-token' })
    expect(attempt.transport).toBe('tcp')
    // The desktop answers graph commands for every Environment it connects to, not only the local one.
    expect(target.capabilities).toEqual(['graph', 'browser', 'wire-ping'])
  })

  it('refuses the attempt for a paired LAN target with no stored secret', async () => {
    await connectEnvironment('env-c', 'LAN Mac', { kind: 'paired', label: 'LAN Mac', url: 'ws://192.168.1.5:7331', credentialRef: 'env-c', via: 'lan' })
    await expect(vi.mocked(broker.connect).mock.calls[0][0].open()).rejects.toThrow(/no paired secret stored/)
  })

  it('refuses the attempt for a paired relay target with no stored secret at the transport-resolution step', async () => {
    await connectEnvironment('env-d', 'Relay Mac', { kind: 'paired', label: 'Relay Mac', url: 'wss://relay.example', credentialRef: 'env-d', via: 'relay' })
    await expect(vi.mocked(broker.connect).mock.calls[0][0].open()).rejects.toThrow()
  })

  /**
   * The regression: an environment whose server is down at launch. Resolving
   * the route and credential used to happen here, before the broker was ever
   * asked to connect, so an unreachable server produced no connection and
   * nothing retried it -- its conversations stayed missing from the Inbox
   * until the operator clicked Reconnect. Now the target reaches the broker
   * regardless, and a later attempt succeeds on its own.
   */
  it('hands an unreachable paired target to the broker anyway, and its next attempt succeeds once the server answers', async () => {
    const originalFetch = globalThis.fetch
    try {
      const sharedSecret = Buffer.alloc(32, 3)
      saveCredential('env-late', 'paired', encodePairedSecret({ clientId: 'c-late', sharedSecret }))
      let serverUp = false
      globalThis.fetch = (async () => {
        if (!serverUp) throw new Error('ECONNREFUSED')
        return new Response(JSON.stringify({ nonce: Buffer.from('n').toString('base64') }), { status: 200 })
      }) as typeof fetch

      await connectEnvironment('env-late', 'Lab', { kind: 'paired', label: 'Lab', url: 'http://lab.example.org:7331', credentialRef: 'env-late', via: 'lan' })
      expect(broker.connect).toHaveBeenCalledTimes(1)
      const handed = vi.mocked(broker.connect).mock.calls[0][0]
      await expect(handed.open()).rejects.toThrow()

      serverUp = true
      const attempt = await handed.open()
      expect(attempt.transport).toBe('tcp')
      expect(attempt.credential).toMatchObject({ kind: 'paired', clientId: 'c-late' })
      attempt.socket.close()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('connectEnvironment: paired LAN credential', () => {
  let dir: string
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ion-env-connect-paired-'))
    _setConnectionsFilePathForTest(join(dir, 'desktop-connections.json'))
    vi.mocked(broker.connect).mockClear()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('presents the server-registered clientId and a proof over the fetched nonce, dialing the ws form of the http url', async () => {
    const sharedSecret = Buffer.alloc(32, 7)
    saveCredential('env-p', 'paired', encodePairedSecret({ clientId: 'abcdef0123456789', sharedSecret }))
    const nonce = Buffer.from('nonce-bytes-for-test').toString('base64')
    const seen: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ nonce, environmentId: 'env-p', label: 'Lab' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    await connectEnvironment('env-p', 'Lab', { kind: 'paired', label: 'Lab', url: 'http://lab.example.org:7331', credentialRef: 'env-p', via: 'lan' })

    expect(broker.connect).toHaveBeenCalledTimes(1)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(seen).toEqual(['http://lab.example.org:7331/auth/config'])
    expect(attempt.transport).toBe('tcp')
    expect(attempt.credential.kind).toBe('paired')
    if (attempt.credential.kind !== 'paired') return
    // Regression: the hello used to carry this process's own UUID, which the
    // server never registered, so every paired connect was refused unauthorized.
    expect(attempt.credential.clientId).toBe('abcdef0123456789')
    expect(verifyAuthProof(nonce, attempt.credential.proof, sharedSecret)).toBe(true)
  })

  it('refuses a stored paired credential that is not a v1 record instead of guessing', async () => {
    saveCredential('env-q', 'paired', Buffer.alloc(32, 1).toString('base64'))
    globalThis.fetch = (async () => new Response(JSON.stringify({ nonce: 'bg==' }), { status: 200 })) as typeof fetch
    await connectEnvironment('env-q', 'Lab', { kind: 'paired', label: 'Lab', url: 'http://lab.example.org:7331', credentialRef: 'env-q', via: 'lan' })
    await expect(vi.mocked(broker.connect).mock.calls[0][0].open()).rejects.toThrow(/unreadable; re-pair/)
  })
})
