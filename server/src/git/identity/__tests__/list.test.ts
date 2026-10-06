import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../../config/current'
import { loadServerConfig } from '../../../config/server-config'
import { writeSecretRef } from '../../../config/secret-ref'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../credential-store'
import { listGitIdentitiesFor, listHostGitIdentities } from '../list'

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

describe('listHostGitIdentities', () => {
  const realHome = process.env.HOME
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ion-git-identity-host-'))
    process.env.HOME = home
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA user@example.org\n')
    writeFileSync(join(home, '.ssh', 'id_work.pub'), 'ssh-ed25519 WORK work@example.org\n')
    writeFileSync(join(home, '.ssh', 'config'), 'Host gitlab.example.org\n  IdentityFile ~/.ssh/id_work\n')
    mkdirSync(join(home, '.config', 'gh'), { recursive: true })
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    user: example-user\n')
  })
  afterEach(() => {
    process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
  })

  it('lists each host key under the hosts it is pinned to, and each cli sign-in', () => {
    setCurrentServerConfig(loadServerConfig(dir))
    expect(listHostGitIdentities()).toEqual([
      { host: '*', source: 'host', kind: 'ssh', publicKey: 'ssh-ed25519 AAAA user@example.org', file: 'id_ed25519.pub' },
      { host: 'gitlab.example.org', source: 'host', kind: 'ssh', publicKey: 'ssh-ed25519 WORK work@example.org', file: 'id_work.pub' },
      { host: 'github.com', source: 'host', kind: 'https-token', username: 'example-user', tool: 'gh' },
    ])
    expect(listGitIdentitiesFor('oidc:alice')).toHaveLength(3)
  })

  it('lists nothing when host credentials are switched off', () => {
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ git: { hostCredentials: false } }))
    setCurrentServerConfig(loadServerConfig(dir))
    expect(listHostGitIdentities()).toEqual([])
    expect(listGitIdentitiesFor('oidc:alice')).toEqual([])
  })
})
