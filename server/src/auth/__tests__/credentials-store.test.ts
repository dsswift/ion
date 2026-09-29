import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { CredentialsStore } from '../credentials-store'

let dir: string
let store: CredentialsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-credentials-store-test-'))
  store = new CredentialsStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CredentialsStore', () => {
  it('starts empty when credentials.json is absent', () => {
    expect(store.list()).toEqual([])
    expect(store.get('anything')).toBeUndefined()
  })

  it('round-trips a registered client and decodes its secret back to the original 32 bytes', () => {
    const secret = randomBytes(32)
    const record = store.add({ clientId: 'client-1', secret, scopes: ['conversations:read'], subject: 'josh', kind: 'desktop', label: ' desktop mac ', deviceId: 'dev-1' })
    expect(record.label).toBe('desktop mac')
    expect(record.deviceId).toBe('dev-1')
    // The same device pairing again supersedes the earlier record.
    store.add({ clientId: 'client-2', secret, scopes: ['conversations:read'], subject: 'josh', kind: 'desktop', deviceId: 'dev-1' })
    expect(store.get('client-1')?.revokedAt).not.toBeNull()
    expect(store.get('client-2')?.revokedAt).toBeNull()
    // A different kind (a phone) with the same id is not the same pairing.
    store.add({ clientId: 'client-3', secret, scopes: [], subject: 'josh', kind: 'mobile', deviceId: 'dev-1' })
    expect(store.get('client-2')?.revokedAt).toBeNull()
    expect(record.revokedAt).toBeNull()

    const reloaded = new CredentialsStore(dir)
    const found = reloaded.get('client-1')
    expect(found).toBeDefined()
    expect(found?.subject).toBe('josh')
    expect(found?.kind).toBe('desktop')

    const decoded = reloaded.secretFor('client-1')
    expect(decoded).not.toBeNull()
    expect(decoded?.equals(secret)).toBe(true)
  })

  it('never writes the plaintext secret to disk', () => {
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: [], subject: 'josh', kind: 'desktop' })
    const raw = readFileSync(join(dir, 'credentials.json'), 'utf-8')
    expect(raw).not.toContain(secret.toString('base64'))
  })

  it('revoke marks revokedAt and secretFor still decodes (revocation is an auth-time check, not a data-deletion)', () => {
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: [], subject: 'josh', kind: 'desktop' })
    expect(store.revoke('client-1')).toBe(true)
    expect(store.get('client-1')?.revokedAt).not.toBeNull()
    expect(store.secretFor('client-1')).not.toBeNull()
  })

  it('revoke returns false for an unknown clientId', () => {
    expect(store.revoke('no-such-client')).toBe(false)
  })

  it('touch updates lastSeen', async () => {
    const secret = randomBytes(32)
    const before = store.add({ clientId: 'client-1', secret, scopes: [], subject: 'josh', kind: 'desktop' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.touch('client-1')
    const after = store.get('client-1')
    expect(after!.lastSeen).toBeGreaterThan(before.lastSeen)
  })

  it('secretFor returns null for an undecodable (wrong-length) stored secret', () => {
    // Simulate a corrupt/legacy record by writing credentials.json directly
    // with a secretRef that decrypts to something that is not 32 bytes.
    const raw = JSON.stringify({
      version: 1,
      clients: [{ clientId: 'client-1', secretRef: 'enc:v3:not-a-real-ciphertext', scopes: [], subject: 'josh', createdAt: 0, lastSeen: 0, revokedAt: null, kind: 'desktop' }],
    })
    writeFileSync(join(dir, 'credentials.json'), raw)
    expect(store.secretFor('client-1')).toBeNull()
  })

  it('malformed credentials.json is treated as an empty registry rather than throwing', () => {
    writeFileSync(join(dir, 'credentials.json'), '{ not json')
    expect(store.list()).toEqual([])
  })
})
