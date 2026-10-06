import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../../config/current'
import { loadServerConfig } from '../../../config/server-config'
import { writeSecretRef } from '../../../config/secret-ref'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../credential-store'
import { registerExchangeSource, resolveGitCredential, _resetResolverSourcesForTest, _setHostSourceForTest } from '../resolver'
import type { GitCredentialSourceProvider } from '../types'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-git-resolver-test-'))
  _resetGitCredentialStoreForTest(dir)
  _resetResolverSourcesForTest()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  _resetCurrentServerConfigForTest()
})

describe('resolveGitCredential: precedence', () => {
  it('returns null when no source has a credential', async () => {
    setCurrentServerConfig(loadServerConfig(dir))
    expect(await resolveGitCredential('oidc:alice', 'github.com')).toBeNull()
  })

  it('falls through to user-supplied when neither admin nor exchange has one', async () => {
    setCurrentServerConfig(loadServerConfig(dir))
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'USER-KEY', publicKey: 'PUB' })
    const resolved = await resolveGitCredential('oidc:alice', 'github.com')
    expect(resolved).toEqual({ source: 'user', kind: 'ssh', host: 'github.com', privateKey: 'USER-KEY', publicKey: 'PUB' })
  })

  it('admin always wins over a user-supplied credential for the same pair', async () => {
    writeSecretRef(dir, 'admin-key', 'ADMIN-KEY')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      git: { credentials: [{ subject: 'oidc:alice', host: 'github.com', kind: 'ssh', keyRef: 'secretstore:admin-key', publicKey: 'ADMIN-PUB' }] },
    }))
    setCurrentServerConfig(loadServerConfig(dir))
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'USER-KEY', publicKey: 'USER-PUB' })

    const resolved = await resolveGitCredential('oidc:alice', 'github.com')
    expect(resolved?.source).toBe('admin')
    expect(resolved?.privateKey).toBe('ADMIN-KEY')
  })

  it('an exchange source wins over user-supplied but loses to admin', async () => {
    setCurrentServerConfig(loadServerConfig(dir))
    const exchange: GitCredentialSourceProvider = {
      name: 'exchange-gitlab',
      resolve: (subject, host) => (subject === 'oidc:alice' && host === 'gitlab.example.com' ? { source: 'exchange-gitlab', kind: 'https-token', host, token: 'EXCHANGE-TOKEN', username: 'oauth2' } : null),
    }
    registerExchangeSource(exchange)
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'https-token', token: 'USER-TOKEN', username: 'alice' })

    const resolved = await resolveGitCredential('oidc:alice', 'gitlab.example.com')
    expect(resolved?.source).toBe('exchange-gitlab')
    expect(resolved?.token).toBe('EXCHANGE-TOKEN')
  })

  it('never leaks one subjects credential to a lookup for another subject', async () => {
    setCurrentServerConfig(loadServerConfig(dir))
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'ALICE-KEY', publicKey: 'p' })
    expect(await resolveGitCredential('oidc:bob', 'github.com')).toBeNull()
  })
})

describe('resolveGitCredential: what the caller can use', () => {
  const hostToken: GitCredentialSourceProvider = { name: 'host', resolve: (_subject, host) => ({ source: 'host', kind: 'https-token', host, token: 'CLI-TOKEN', username: 'x-access-token' }) }

  it('leaves the host source out unless the caller can use a token', async () => {
    setCurrentServerConfig(loadServerConfig(dir))
    _setHostSourceForTest(hostToken)
    expect(await resolveGitCredential('oidc:alice', 'github.com')).toBeNull()
    expect(await resolveGitCredential('oidc:alice', 'github.com', { transport: 'ssh' })).toBeNull()
    expect((await resolveGitCredential('oidc:alice', 'github.com', { transport: 'https' }))?.source).toBe('host')
    expect((await resolveGitCredential('oidc:alice', 'github.com', { kind: 'https-token' }))?.token).toBe('CLI-TOKEN')
  })

  it('prefers a stored credential over the host source', async () => {
    setCurrentServerConfig(loadServerConfig(dir))
    _setHostSourceForTest(hostToken)
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'https-token', token: 'STORED', username: 'alice' })
    expect((await resolveGitCredential('oidc:alice', 'github.com', { kind: 'https-token' }))?.token).toBe('STORED')
  })

  it('passes over a stored credential of the other kind when a kind is asked for', async () => {
    setCurrentServerConfig(loadServerConfig(dir))
    _setHostSourceForTest(hostToken)
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'USER-KEY', publicKey: 'PUB' })
    expect((await resolveGitCredential('oidc:alice', 'github.com', { transport: 'https' }))?.kind).toBe('ssh')
    expect((await resolveGitCredential('oidc:alice', 'github.com', { kind: 'https-token' }))?.source).toBe('host')
    expect((await resolveGitCredential('oidc:alice', 'github.com', { kind: 'ssh' }))?.source).toBe('user')
  })
})
