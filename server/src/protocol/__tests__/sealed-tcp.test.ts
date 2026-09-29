/**
 * Sealed frames for a paired client on the TCP listener.
 *
 * The listener speaks plain `ws://`. A paired client's HMAC proof
 * authenticates it and then leaves the whole session readable on the LAN, so
 * a paired client names itself at upgrade time (`?client=<id>`) and every
 * frame either way is an AES-256-GCM envelope under its pairing secret.
 * Driven over a real listener and a real `ws` client: the seam under test is
 * the upgrade path, which a fake socket would skip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../state', () => ({
  engineBridge: { connected: true },
  deviceFocusMap: new Map(),
  state: { remoteTransport: null },
}))

import { startHarness, waitOpen, helloFrame, closeSocket, resetConnectionRegistryForTest, type Harness } from './harness'
import { sealedClientParam } from '../listener'
import { DefaultAuthPolicy } from '../../auth/auth-policy'
import { credentialsStore, _resetCredentialsStoreForTest } from '../../auth/credentials-store'
import { browserSessionStore } from '../../auth/browser-session-store'
import { currentNonce, _resetNonceForTest } from '../../auth/nonce'
import { createAuthProof } from '@ion/shared/e2e'
import { sealRelayFrame, openRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../config/current'
import { defaultServerConfig } from '../../config/server-config'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

const SECRET = Buffer.alloc(32, 7)
const OTHER_SECRET = Buffer.alloc(32, 9)
const CLIENT = 'client-sealed-1'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

function configure(allowUnsealedPaired: boolean): void {
  const config = defaultServerConfig()
  config.listen.tcp.allowUnsealedPaired = allowUnsealedPaired
  setCurrentServerConfig(config)
}

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-sealed-tcp-'))
  process.env.ION_DATA_DIR = dataDir
  _resetCredentialsStoreForTest(dataDir)
  _resetNonceForTest()
  configure(false)
  credentialsStore().add({ clientId: CLIENT, secret: SECRET, scopes: ['conversations:read'], subject: 'paired:sealed', kind: 'desktop' })
  harness = await startHarness({ authPolicy: new DefaultAuthPolicy({ oidc: null, credentials: credentialsStore(), sessions: browserSessionStore() }) })
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  _resetCurrentServerConfigForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function pairedHello(clientId = CLIENT, secret = SECRET): StudioFrame {
  return helloFrame({ clientId, credential: { kind: 'paired', clientId, proof: createAuthProof(currentNonce(), secret) } })
}

/** The next text frame as raw text: a sealed socket answers in envelopes, which `nextFrame` would misread as a StudioFrame. */
function nextText(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nextText timed out')), timeoutMs)
    ws.once('message', (data: WebSocket.RawData) => {
      clearTimeout(timer)
      resolve((data as Buffer).toString('utf-8'))
    })
    ws.once('close', () => {
      clearTimeout(timer)
      reject(new Error('socket closed before a frame arrived'))
    })
  })
}

function openFrame(text: string, secret = SECRET): StudioFrame | null {
  const opened = openRelayFrame(text, secret)
  return opened ? (JSON.parse(opened.bytes.toString('utf-8')) as StudioFrame) : null
}

describe('sealed tcp', () => {
  it('admits a sealed paired hello, and answers in an envelope only that pairing can open', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${harness.tcpPort}/studio?client=${CLIENT}`)
    await waitOpen(ws)
    ws.send(sealRelayFrame(JSON.stringify(pairedHello()), SECRET))
    const reply = await nextText(ws)

    // Nothing readable on the wire: the reply is an envelope, not a frame.
    expect(JSON.parse(reply)).toMatchObject({ v: 1 })
    expect(reply).not.toContain('studio_welcome')
    expect(openFrame(reply, OTHER_SECRET)).toBeNull()
    expect(openFrame(reply)).toMatchObject({ type: 'studio_welcome', environmentId: 'env-test', principal: { subject: 'paired:sealed' } })
    await closeSocket(ws)
  })

  it('refuses an UNSEALED paired hello, and says why', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${harness.tcpPort}/studio`)
    await waitOpen(ws)
    ws.send(JSON.stringify(pairedHello()))
    const frame = JSON.parse(await nextText(ws)) as StudioFrame
    expect(frame).toMatchObject({ type: 'studio_refused', reason: 'unauthorized' })
    expect((frame as { detail?: string }).detail).toMatch(/sealed frames/)
    await closeSocket(ws)
  })

  it('admits an unsealed paired hello only when the operator allowed it', async () => {
    configure(true)
    const ws = new WebSocket(`ws://127.0.0.1:${harness.tcpPort}/studio`)
    await waitOpen(ws)
    ws.send(JSON.stringify(pairedHello()))
    expect(JSON.parse(await nextText(ws))).toMatchObject({ type: 'studio_welcome' })
    await closeSocket(ws)
  })

  it('drops a frame sealed with the wrong secret: no reply, no welcome', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${harness.tcpPort}/studio?client=${CLIENT}`)
    await waitOpen(ws)
    ws.send(sealRelayFrame(JSON.stringify(pairedHello(CLIENT, OTHER_SECRET)), OTHER_SECRET))
    await expect(nextText(ws, 300)).rejects.toThrow(/timed out/)
    await closeSocket(ws)
  })

  it('refuses a hello naming a different client than the socket was sealed for', async () => {
    credentialsStore().add({ clientId: 'client-other', secret: SECRET, scopes: ['conversations:read'], subject: 'paired:other', kind: 'desktop' })
    const ws = new WebSocket(`ws://127.0.0.1:${harness.tcpPort}/studio?client=${CLIENT}`)
    await waitOpen(ws)
    ws.send(sealRelayFrame(JSON.stringify(pairedHello('client-other')), SECRET))
    expect(openFrame(await nextText(ws))).toEqual({ type: 'studio_refused', reason: 'unauthorized' })
    await closeSocket(ws)
  })

  it('closes the upgrade for an unknown or revoked client: there is no secret to open its frames with', async () => {
    const unknown = new WebSocket(`ws://127.0.0.1:${harness.tcpPort}/studio?client=nobody`)
    const code = await new Promise<number>((resolve) => unknown.once('close', (c: number) => resolve(c)))
    expect(code).toBe(1008)

    credentialsStore().revoke(CLIENT)
    const revoked = new WebSocket(`ws://127.0.0.1:${harness.tcpPort}/studio?client=${CLIENT}`)
    expect(await new Promise<number>((resolve) => revoked.once('close', (c: number) => resolve(c)))).toBe(1008)
  })
})

describe('sealedClientParam', () => {
  it('reads the client a TCP upgrade named, and nothing else', () => {
    expect(sealedClientParam('/studio?client=abc123')).toBe('abc123')
    expect(sealedClientParam('/studio')).toBeNull()
    expect(sealedClientParam('/studio?client=')).toBeNull()
    expect(sealedClientParam(undefined)).toBeNull()
    expect(sealedClientParam(`/studio?client=${'x'.repeat(200)}`)).toBeNull()
  })
})
