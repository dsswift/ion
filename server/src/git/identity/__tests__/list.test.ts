import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../../config/current'
import { loadServerConfig } from '../../../config/server-config'
import { writeSecretRef } from '../../../config/secret-ref'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../credential-store'
import { listGitIdentitiesFor } from '../list'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-git-identity-list-test-'))
  _resetGitCredentialStoreForTest(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  _resetCurrentServerConfigForTest()
})

describe('listGitIdentitiesFor', () => {
  it('returns an empty list when the subject has nothing configured', () => {
    setCurrentServerConfig(loadServerConfig(dir))
    expect(listGitIdentitiesFor('oidc:alice')).toEqual([])
  })

  it('lists admin entries before user-supplied ones', () => {
    writeSecretRef(dir, 'admin-key', 'ADMIN-KEY')
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      git: { credentials: [{ subject: 'oidc:alice', host: 'github.com', kind: 'ssh', keyRef: 'secretstore:admin-key', publicKey: 'ADMIN-PUB' }] },
    }))
    setCurrentServerConfig(loadServerConfig(dir))
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'https-token', token: 't', username: 'alice' })

    const list = listGitIdentitiesFor('oidc:alice')
    expect(list).toEqual([
      { host: 'github.com', source: 'admin', kind: 'ssh', publicKey: 'ADMIN-PUB', username: undefined },
      { host: 'gitlab.example.com', source: 'user', kind: 'https-token', publicKey: undefined, username: 'alice' },
    ])
  })

  it('never leaks another subjects credential', () => {
    setCurrentServerConfig(loadServerConfig(dir))
    gitCredentialStore().set({ subject: 'oidc:bob', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'k', publicKey: 'p' })
    expect(listGitIdentitiesFor('oidc:alice')).toEqual([])
  })

  it('never includes a raw secret -- only redacted fields', () => {
    setCurrentServerConfig(loadServerConfig(dir))
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'SECRET-KEY-MATERIAL', publicKey: 'p' })
    const list = listGitIdentitiesFor('oidc:alice')
    expect(JSON.stringify(list)).not.toContain('SECRET-KEY-MATERIAL')
  })
})
