/**
 * A paired laptop carried from home to the office. Its saved address is its
 * home address, which answers nothing on the office network, even with this
 * desktop on the same Wi-Fi. Its last welcome reported where else it answers,
 * ending with its `.local` name; the route finds it there.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../transport-tcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport-tcp')>()
  const stub = () => ({ on() {}, once() {}, close() {}, send() {}, readyState: 0, OPEN: 1 })
  return { ...actual, connectTcp: vi.fn(stub), connectSealedTcp: vi.fn(stub) }
})

vi.mock('../broker-instance', () => ({
  broker: { connect: vi.fn(), disconnect: vi.fn(), phaseOf: vi.fn(() => undefined as unknown), sendAction: vi.fn(), onFrame: vi.fn(() => () => {}) },
}))

import { connectEnvironment, disconnectEnvironment, rememberDirectAddresses, rememberAdvertisedRelays } from '../environment-connect'
import { findDirectUrl, directCandidates } from '../direct-route'
import { encodePairedSecret, decodePairedSecret } from '../paired-secret'
import { connectTcp } from '../transport-tcp'
import { broker } from '../broker-instance'
import { _setConnectionsFilePathForTest, saveCredential, loadCredential } from '../credentials'
import { RelayStudioSocket } from '../transport-relay'

const secret = Buffer.alloc(32, 9)
const relays = [{ url: 'wss://relay.example', auth: { mode: 'psk' as const, key: 'psk-1' } }]
const HOME = 'http://192.168.1.211:7331'
const NAME = 'http://macbook.local:7331'
const target = { kind: 'paired' as const, label: 'Work laptop', url: HOME, credentialRef: 'env-w', via: 'lan' as const, environmentId: 'env-w' }

/** A network where only the given base URLs answer, each reporting an environment id. */
function network(answers: Record<string, string>): { seen: string[] } {
  const seen: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const base = url.replace(/\/auth\/config$/, '')
    if (!(base in answers)) throw new Error('ETIMEDOUT')
    return new Response(JSON.stringify({ nonce: Buffer.from('n').toString('base64'), environmentId: answers[base] }), { status: 200 })
  }) as typeof fetch
  return { seen }
}

describe('a paired server that moved to another network', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    _setConnectionsFilePathForTest(join(mkdtempSync(join(tmpdir(), 'ion-direct-route-')), 'desktop-connections.json'))
    vi.mocked(broker.connect).mockClear()
    vi.mocked(connectTcp).mockClear()
  })
  afterEach(() => {
    disconnectEnvironment('env-w')
    globalThis.fetch = originalFetch
  })

  it('is dialed at the .local name it reported when its saved address is silent, instead of the relay', async () => {
    saveCredential('env-w', 'paired', encodePairedSecret({ clientId: 'c-w', sharedSecret: secret, relays, directAddresses: [HOME, NAME] }))
    const { seen } = network({ [NAME]: 'env-w' })

    await connectEnvironment('env-w', 'Work laptop', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()

    expect(attempt.transport).toBe('tcp')
    expect(attempt.socket).not.toBeInstanceOf(RelayStudioSocket)
    expect(attempt.credential).toMatchObject({ kind: 'paired', clientId: 'c-w' })
    // The nonce comes from the address that answered, and the socket goes there too.
    expect(seen.at(-1)).toBe(`${NAME}/auth/config`)
    expect(vi.mocked(connectTcp).mock.calls.at(-1)?.[0]).toBe(NAME)
  })

  it('is found without any relay stored at all', async () => {
    saveCredential('env-w', 'paired', encodePairedSecret({ clientId: 'c-w', sharedSecret: secret, directAddresses: [NAME] }))
    network({ [NAME]: 'env-w' })
    await connectEnvironment('env-w', 'Work laptop', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(attempt.transport).toBe('tcp')
    expect(vi.mocked(connectTcp).mock.calls.at(-1)?.[0]).toBe(NAME)
  })

  it('skips an address that answers as a different server, and falls back to the relay', async () => {
    saveCredential('env-w', 'paired', encodePairedSecret({ clientId: 'c-w', sharedSecret: secret, relays, directAddresses: [NAME] }))
    network({ [NAME]: 'someone-else' })
    await connectEnvironment('env-w', 'Work laptop', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(attempt.transport).toBe('relay')
    attempt.socket.close()
  })

  it('still dials the saved address when it answers, as at home', async () => {
    saveCredential('env-w', 'paired', encodePairedSecret({ clientId: 'c-w', sharedSecret: secret, relays, directAddresses: [HOME, NAME] }))
    network({ [HOME]: 'env-w' })
    await connectEnvironment('env-w', 'Work laptop', target)
    const attempt = await vi.mocked(broker.connect).mock.calls[0][0].open()
    expect(attempt.transport).toBe('tcp')
    expect(vi.mocked(connectTcp).mock.calls.at(-1)?.[0]).toBe(HOME)
  })
})

describe('rememberDirectAddresses', () => {
  beforeEach(() => {
    _setConnectionsFilePathForTest(join(mkdtempSync(join(tmpdir(), 'ion-direct-remember-')), 'desktop-connections.json'))
  })

  it('stores what each welcome reports beside the secret and its relays, dropping entries that are not urls', () => {
    saveCredential('env-w', 'paired', encodePairedSecret({ clientId: 'c-w', sharedSecret: secret, relays }))
    expect(rememberDirectAddresses('env-w', target, [HOME, 'not a url', 42, NAME])).toBe(true)
    const stored = decodePairedSecret(loadCredential('env-w')!.plaintext)!
    expect(stored.directAddresses).toEqual([HOME, NAME])
    expect(stored.relays).toEqual(relays)
    expect(stored.sharedSecret.equals(secret)).toBe(true)
    // Unchanged on the next welcome: nothing is rewritten.
    expect(rememberDirectAddresses('env-w', target, [HOME, NAME])).toBe(false)
    // A later relay update keeps the addresses.
    rememberAdvertisedRelays('env-w', target, [])
    expect(decodePairedSecret(loadCredential('env-w')!.plaintext)!.directAddresses).toEqual([HOME, NAME])
  })
})

describe('findDirectUrl', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('accepts a saved address whose server reports no id, but never a reported one', async () => {
    network({ [HOME]: '', [NAME]: '' })
    expect(await findDirectUrl('env-w', HOME, [NAME])).toBe(HOME)
    network({ [NAME]: '' })
    expect(await findDirectUrl('env-w', HOME, [NAME])).toBeNull()
  })

  it('lists the saved address first and each other address once', () => {
    expect(directCandidates(HOME, [`${HOME}/`, NAME, 'ws://192.168.1.211:7331/studio'])).toEqual([HOME, NAME])
  })
})
