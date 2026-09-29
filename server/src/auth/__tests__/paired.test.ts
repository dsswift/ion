import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes, createHmac } from 'crypto'
import { verifyPaired } from '../paired'
import { CredentialsStore } from '../credentials-store'
import { _resetNonceForTest, _setNonceTtlForTest, currentNonce } from '../nonce'

// The shared-tenancy fold now checks the engine's signed-in Entra identity
// before falling back to the OS username (`resolveLocalConnectionPrincipal`).
// These tests exercise the "nobody is signed in" fallback specifically, so
// the engine round trip is mocked out rather than left to hit a real bridge.
vi.mock('../../oauth/entra-flow', () => ({ getSignedInIdentityIfEngineConnected: vi.fn().mockResolvedValue(null) }))

let dir: string
let store: CredentialsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-paired-test-'))
  store = new CredentialsStore(dir)
  _resetNonceForTest()
})

afterEach(() => {
  _resetNonceForTest()
  rmSync(dir, { recursive: true, force: true })
})

function proofFor(secret: Buffer, nonce: string): string {
  return createHmac('sha256', secret).update(Buffer.from(nonce, 'base64url')).digest('base64')
}

describe('verifyPaired', () => {
  it('accepts a valid proof and grants the stored scopes', async () => {
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: ['conversations:read', 'terminal:operate'], subject: 'paired:client-1', kind: 'desktop' })
    const nonce = currentNonce()
    const proof = proofFor(secret, nonce)

    const result = await verifyPaired({ kind: 'paired', clientId: 'client-1', proof }, store)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.principal.subject).toBe('paired:client-1')
      expect(result.scopes).toEqual(['conversations:read', 'terminal:operate'])
    }
  })

  it('accepts a proof computed against the previous nonce (rotation grace window)', async () => {
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: ['conversations:read'], subject: 'paired:client-1', kind: 'desktop' })

    _setNonceTtlForTest(20)
    const staleNonce = currentNonce()
    const proof = proofFor(secret, staleNonce)

    // Rotate: the client's proof was computed against `staleNonce` before
    // the TTL elapsed; a real hello can arrive just after rotation, and the
    // proof must still verify against `previous`.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(currentNonce()).not.toBe(staleNonce)

    const result = await verifyPaired({ kind: 'paired', clientId: 'client-1', proof }, store)
    expect(result.ok).toBe(true)
  })

  it('refuses a proof computed against a nonce that has rotated out of the grace window', async () => {
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: ['conversations:read'], subject: 'paired:client-1', kind: 'desktop' })

    _setNonceTtlForTest(20)
    const staleNonce = currentNonce()
    const proof = proofFor(secret, staleNonce)

    // Two rotations: `staleNonce` is no longer `current` or `previous`.
    await new Promise((resolve) => setTimeout(resolve, 30))
    currentNonce()
    await new Promise((resolve) => setTimeout(resolve, 30))
    currentNonce()

    const result = await verifyPaired({ kind: 'paired', clientId: 'client-1', proof }, store)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('refuses a revoked client with credential_revoked', async () => {
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: ['conversations:read'], subject: 'paired:client-1', kind: 'desktop' })
    store.revoke('client-1')
    const proof = proofFor(secret, currentNonce())

    const result = await verifyPaired({ kind: 'paired', clientId: 'client-1', proof }, store)
    expect(result).toMatchObject({ ok: false, reason: 'credential_revoked' })
  })

  it('refuses a wrong proof', async () => {
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: ['conversations:read'], subject: 'paired:client-1', kind: 'desktop' })
    currentNonce()

    const wrongProof = createHmac('sha256', randomBytes(32)).update(Buffer.from(currentNonce(), 'base64url')).digest('base64')
    const result = await verifyPaired({ kind: 'paired', clientId: 'client-1', proof: wrongProof }, store)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('refuses an unknown clientId', async () => {
    const result = await verifyPaired({ kind: 'paired', clientId: 'no-such-client', proof: 'anything' }, store)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })
})

describe('verifyPaired: host identity', () => {
  it('shared tenancy folds a device-shaped record into the host identity; isolated keeps the record subject', async () => {
    const { setCurrentServerConfig, currentServerConfig, _resetCurrentServerConfigForTest } = await import('../../config/current')
    const { userInfo } = await import('os')
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: ['conversations:read'], subject: 'paired:dev-1', kind: 'desktop', label: 'my laptop' })
    const proof = proofFor(secret, currentNonce())
    try {
      setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
      const shared = await verifyPaired({ kind: 'paired', clientId: 'client-1', proof }, store)
      expect(shared.ok).toBe(true)
      if (shared.ok) expect(shared.principal).toEqual({ subject: `local:${userInfo().username}`, displayName: userInfo().username, provider: 'os', kind: 'local', username: userInfo().username })

      setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'isolated' } })
      const isolated = await verifyPaired({ kind: 'paired', clientId: 'client-1', proof }, store)
      expect(isolated.ok).toBe(true)
      if (isolated.ok) expect(isolated.principal).toEqual({ subject: 'paired:dev-1', displayName: 'my laptop' })
    } finally {
      _resetCurrentServerConfigForTest()
    }
  })

  it('shared tenancy still reports the host identity once the stored record already carries the host subject (the common case after the first fold)', async () => {
    // Regression: a device paired under shared tenancy (or already migrated
    // by host-identity-migration) stores subject "local:<username>" from the
    // start -- NOT "paired:*". A record in that state used to fall through
    // pairedPrincipal's device-shaped check and report the device's own
    // pairing label ("iPhone") as the displayName for every subsequent
    // login, even though the subject was already correctly the host's. That
    // label then overwrote the shared principal-registry entry (last writer
    // wins), so a completely unrelated desktop session would read "iPhone"
    // back as this person's display name.
    const { setCurrentServerConfig, currentServerConfig, _resetCurrentServerConfigForTest } = await import('../../config/current')
    const { userInfo } = await import('os')
    const secret = randomBytes(32)
    const hostSubject = `local:${userInfo().username}`
    store.add({ clientId: 'client-2', secret, scopes: ['conversations:read'], subject: hostSubject, kind: 'mobile', label: 'iPhone' })
    const proof = proofFor(secret, currentNonce())
    try {
      setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
      const result = await verifyPaired({ kind: 'paired', clientId: 'client-2', proof }, store)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.principal).toEqual({ subject: hostSubject, displayName: userInfo().username, provider: 'os', kind: 'local', username: userInfo().username })
    } finally {
      _resetCurrentServerConfigForTest()
    }
  })
})
