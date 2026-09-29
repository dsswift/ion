import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DiscoveryWindow, MAX_FAILED_ATTEMPTS, type DiscoveryDeps } from '../window'
import { mintDiscoveryCode, normalizeDiscoveryCode, formatDiscoveryCode } from '../code'
import { completePairing, _resetPairingLinksForTest, type PairingCaller } from '../../auth/pairing-links'
import { CredentialsStore } from '../../auth/credentials-store'
import { generateKeyPair } from '../../remote/crypto'
import type { Advertiser } from '../advertiser'

const admin: PairingCaller = { subject: 'local:tester', scopes: ['admin'] }
const peer = (): string => generateKeyPair().publicKey.toString('base64')

function fakeAdvertiser(): Advertiser & { starts: number; stops: number } {
  const a = { advertising: false, starts: 0, stops: 0, start() { a.advertising = true; a.starts++ }, stop() { if (a.advertising) a.stops++; a.advertising = false } }
  return a
}

let dir: string
let store: CredentialsStore
let advertiser: ReturnType<typeof fakeAdvertiser>
let sealed: boolean
let persistent: boolean
let changes: Array<{ mode: string; advertising: boolean }>
let window: DiscoveryWindow

function make(): DiscoveryWindow {
  const deps: DiscoveryDeps = {
    advertiser,
    advertisement: () => ({ label: 'box', environmentId: 'env-1', serverVersion: '0.1.0', port: 7331, machineId: 'MACHINE-1', mobilePort: 0 }),
    policy: () => (sealed ? { customFields: { 'ion-studio': { lanDiscovery: 'disabled' } } } : null),
    persistent: () => persistent,
    defaultScopes: () => ['conversations:read'],
    onChange: (s) => changes.push(s),
  }
  return new DiscoveryWindow(deps)
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'ion-discovery-'))
  store = new CredentialsStore(dir)
  _resetPairingLinksForTest()
  advertiser = fakeAdvertiser(); sealed = false; persistent = false; changes = []
  window = make()
})
afterEach(() => { window.dispose(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

describe('discovery code', () => {
  it('is eight unambiguous characters, shown grouped, accepted with or without the dash in any case', () => {
    const code = mintDiscoveryCode()
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/)
    expect(formatDiscoveryCode('ABCDEFGH')).toBe('ABCD-EFGH')
    expect(normalizeDiscoveryCode('abcd-efgh')).toBe('ABCDEFGH')
    expect(normalizeDiscoveryCode(' ABCD EFGH ')).toBe('ABCDEFGH')
    expect(normalizeDiscoveryCode('ABCDEFG')).toBeNull()
    expect(normalizeDiscoveryCode('ABCD-EFG0')).toBeNull()
  })
})

describe('DiscoveryWindow', () => {
  it('is off by default: nothing is advertised and no code is live', () => {
    window.reconcile()
    expect(window.status()).toEqual({ mode: 'off', advertising: false, until: null, code: null })
    expect(advertiser.starts).toBe(0)
  })

  it('a window advertises with a live code, then shuts itself off when its time is up', () => {
    const opened = window.open(admin, 15)
    expect(opened.ok).toBe(true)
    expect(window.status()).toMatchObject({ mode: 'window', advertising: true })
    expect(window.status().code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    vi.advanceTimersByTime(15 * 60_000 + 1)
    expect(window.status()).toEqual({ mode: 'off', advertising: false, until: null, code: null })
    expect(advertiser.stops).toBe(1)
    expect(changes.at(-1)).toMatchObject({ mode: 'off', advertising: false })
  })

  it('bounds the window length', () => {
    expect(window.open(admin, 0)).toMatchObject({ ok: false, refusal: { code: 'invalid_args' } })
    expect(window.open(admin, 61)).toMatchObject({ ok: false, refusal: { code: 'invalid_args' } })
    expect(advertiser.starts).toBe(0)
  })

  it('an enterprise seal refuses a window, ignores a persistent config, and turns an open window off', () => {
    sealed = true
    expect(window.open(admin, 15)).toMatchObject({ ok: false, refusal: { code: 'sealed' } })
    persistent = true
    window.reconcile()
    expect(window.status()).toMatchObject({ mode: 'sealed', advertising: false })
    expect(window.mintCode(admin)).toMatchObject({ ok: false, refusal: { code: 'sealed' } })

    sealed = false; persistent = false
    expect(window.open(admin, 15).ok).toBe(true)
    sealed = true
    window.reconcile()
    expect(window.status()).toMatchObject({ mode: 'sealed', advertising: false, code: null })
  })

  it('a persistent config advertises continuously with no code until one is asked for, and survives a window closing', () => {
    persistent = true
    window.reconcile()
    expect(window.status()).toMatchObject({ mode: 'persistent', advertising: true, code: null })
    const minted = window.mintCode(admin)
    expect(minted.ok).toBe(true)
    expect(window.open(admin, 5).ok).toBe(true)
    window.close()
    expect(window.status()).toMatchObject({ mode: 'persistent', advertising: true })
  })

  it('the typed code pairs one device, and a fresh code replaces it while the window is open', () => {
    window.open(admin, 15)
    const first = window.status().code!
    const paired = completePairing(store, { code: first.toLowerCase(), peerPublicKey: peer(), label: 'laptop', kind: 'desktop' })
    expect(paired.ok).toBe(true)
    const second = window.status().code
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(completePairing(store, { code: first, peerPublicKey: peer(), label: 'x', kind: 'desktop' })).toMatchObject({ ok: false })
  })

  it('burns the live code after too many wrong guesses, so guessing has to start over', () => {
    window.open(admin, 15)
    const first = window.status().code!
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) completePairing(store, { code: 'ZZZZ-ZZZZ', peerPublicKey: peer(), label: 'x', kind: 'desktop' })
    expect(window.status().code).not.toBe(first)
    expect(completePairing(store, { code: first, peerPublicKey: peer(), label: 'x', kind: 'desktop' })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('closing a window revokes its code', () => {
    window.open(admin, 15)
    const code = window.status().code!
    window.close()
    expect(completePairing(store, { code, peerPublicKey: peer(), label: 'x', kind: 'desktop' })).toMatchObject({ ok: false, reason: 'not_found' })
  })
})
