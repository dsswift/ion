import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitCredentialStore } from '../credential-store'

let dir: string
let store: GitCredentialStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-git-credential-store-test-'))
  store = new GitCredentialStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('GitCredentialStore', () => {
  it('starts empty when git-credentials.json is absent', () => {
    expect(store.listFor('oidc:alice')).toEqual([])
    expect(store.get('oidc:alice', 'github.com')).toBeUndefined()
  })

  it('round-trips an SSH credential and decrypts its private key back to the original text', () => {
    store.set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'PRIVATE-KEY-TEXT', publicKey: 'ssh-ed25519 AAAA' })

    const reloaded = new GitCredentialStore(dir)
    const found = reloaded.get('oidc:alice', 'github.com')
    expect(found?.source).toBe('user')
    expect(found?.kind).toBe('ssh')
    expect(found?.publicKey).toBe('ssh-ed25519 AAAA')
    expect(found?.privateKeyRef).not.toBe('PRIVATE-KEY-TEXT') // encrypted at rest
    expect(reloaded.privateKeyFor('oidc:alice', 'github.com')).toBe('PRIVATE-KEY-TEXT')
  })

  it('round-trips an HTTPS token credential', () => {
    store.set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'https-token', token: 'glpat-secret', username: 'alice' })
    expect(store.tokenFor('oidc:alice', 'gitlab.example.com')).toBe('glpat-secret')
    expect(store.get('oidc:alice', 'gitlab.example.com')?.username).toBe('alice')
  })

  it('keys credentials per (subject, host) -- two hosts for one subject coexist', () => {
    store.set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'k1', publicKey: 'p1' })
    store.set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'https-token', token: 't1', username: 'alice' })
    expect(store.listFor('oidc:alice')).toHaveLength(2)
  })

  it('two subjects never see each others credential for the same host', () => {
    store.set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'alice-key', publicKey: 'p1' })
    store.set({ subject: 'oidc:bob', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'bob-key', publicKey: 'p2' })
    expect(store.privateKeyFor('oidc:alice', 'github.com')).toBe('alice-key')
    expect(store.privateKeyFor('oidc:bob', 'github.com')).toBe('bob-key')
  })

  it('replaces an existing record for the same (subject, host), preserving createdAt', () => {
    const first = store.set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'k1', publicKey: 'p1' })
    const second = store.set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'https-token', token: 't2', username: 'alice' })
    expect(second.createdAt).toBe(first.createdAt)
    expect(store.listFor('oidc:alice')).toHaveLength(1)
    expect(store.get('oidc:alice', 'github.com')?.kind).toBe('https-token')
  })

  it('remove() deletes the record and returns true; returns false when absent', () => {
    store.set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'k1', publicKey: 'p1' })
    expect(store.remove('oidc:alice', 'github.com')).toBe(true)
    expect(store.get('oidc:alice', 'github.com')).toBeUndefined()
    expect(store.remove('oidc:alice', 'github.com')).toBe(false)
  })

  it('privateKeyFor returns null for a https-token record', () => {
    store.set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'https-token', token: 't1', username: 'alice' })
    expect(store.privateKeyFor('oidc:alice', 'gitlab.example.com')).toBeNull()
  })

  it('refreshTokenFor decrypts a stored OAuth refresh token', () => {
    store.set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'exchange-gitlab', kind: 'https-token', token: 'access-1', username: 'oauth2', refreshToken: 'refresh-1' })
    expect(store.refreshTokenFor('oidc:alice', 'gitlab.example.com')).toBe('refresh-1')
  })
})
