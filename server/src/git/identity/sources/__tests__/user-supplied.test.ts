import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitCredentialStore } from '../../credential-store'
import { mintSshKeypair, removeUserCredential, setHttpsToken, setSshPrivateKey, userSuppliedSource } from '../user-supplied'

let dir: string
let store: GitCredentialStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-git-user-supplied-test-'))
  store = new GitCredentialStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('mintSshKeypair', () => {
  it('generates a real ed25519 keypair and stores the private half', async () => {
    const { publicKey } = await mintSshKeypair(store, 'oidc:alice', 'github.com')
    expect(publicKey).toMatch(/^ssh-ed25519 /)
    expect(store.get('oidc:alice', 'github.com')?.source).toBe('user')
    expect(store.get('oidc:alice', 'github.com')?.kind).toBe('ssh')
    expect(store.privateKeyFor('oidc:alice', 'github.com')).toContain('PRIVATE KEY')
  })

  it('returns a fresh keypair on every call -- two mints for the same pair never collide', async () => {
    const first = await mintSshKeypair(store, 'oidc:alice', 'github.com')
    const second = await mintSshKeypair(store, 'oidc:alice', 'github.com')
    expect(first.publicKey).not.toBe(second.publicKey)
  })
})

describe('setSshPrivateKey', () => {
  it('accepts a real pasted private key and derives its public key', async () => {
    const minted = await mintSshKeypair(store, 'oidc:temp', 'scratch.example.com')
    const privateKey = store.privateKeyFor('oidc:temp', 'scratch.example.com')!

    const { publicKey } = await setSshPrivateKey(store, 'oidc:bob', 'gitlab.example.com', privateKey)
    expect(publicKey).toBe(minted.publicKey)
    expect(store.get('oidc:bob', 'gitlab.example.com')?.source).toBe('user')
  })

  it('rejects garbage that is not a valid SSH private key', async () => {
    await expect(setSshPrivateKey(store, 'oidc:bob', 'gitlab.example.com', 'not a key at all')).rejects.toThrow()
    expect(store.get('oidc:bob', 'gitlab.example.com')).toBeUndefined()
  })
})

describe('setHttpsToken / removeUserCredential', () => {
  it('stores and reads back a pasted token', () => {
    setHttpsToken(store, 'oidc:alice', 'gitlab.example.com', 'glpat-secret', 'alice')
    expect(store.tokenFor('oidc:alice', 'gitlab.example.com')).toBe('glpat-secret')
  })

  it('removes only a user-sourced credential, never an admin/exchange one', () => {
    store.set({ subject: 'oidc:alice', host: 'github.com', source: 'admin', kind: 'ssh', privateKey: 'k', publicKey: 'p' })
    expect(removeUserCredential(store, 'oidc:alice', 'github.com')).toBe(false)
    expect(store.get('oidc:alice', 'github.com')).toBeDefined()

    setHttpsToken(store, 'oidc:alice', 'gitlab.example.com', 't', 'alice')
    expect(removeUserCredential(store, 'oidc:alice', 'gitlab.example.com')).toBe(true)
    expect(store.get('oidc:alice', 'gitlab.example.com')).toBeUndefined()
  })
})

describe('userSuppliedSource', () => {
  it('resolves a stored ssh credential', async () => {
    await mintSshKeypair(store, 'oidc:alice', 'github.com')
    const source = userSuppliedSource(store)
    const resolved = source.resolve('oidc:alice', 'github.com')
    expect(resolved && !(resolved instanceof Promise) ? resolved.kind : null).toBe('ssh')
  })

  it('never resolves an admin/exchange-sourced record -- those are different resolver tiers', () => {
    store.set({ subject: 'oidc:alice', host: 'github.com', source: 'admin', kind: 'ssh', privateKey: 'k', publicKey: 'p' })
    const source = userSuppliedSource(store)
    expect(source.resolve('oidc:alice', 'github.com')).toBeNull()
  })

  it('returns null when nothing is stored', () => {
    const source = userSuppliedSource(store)
    expect(source.resolve('oidc:alice', 'github.com')).toBeNull()
  })
})
