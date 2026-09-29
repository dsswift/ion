import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { migrateToHostIdentity } from '../host-identity-migration'
import { _resetCredentialsStoreForTest, credentialsStore } from '../../auth/credentials-store'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../../git/identity/credential-store'
import { _resetPrincipalRegistryForTest, lookupPrincipal } from '../principal-registry'
import { principalDir } from '../../conversation/principal-dir'

const HOST = 'local:tester'
let dir: string
let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-host-identity-'))
  process.env.ION_DATA_DIR = dir
  _resetCredentialsStoreForTest(dir)
  _resetGitCredentialStoreForTest(dir)
  _resetPrincipalRegistryForTest()
})

afterEach(() => {
  _resetPrincipalRegistryForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dir, { recursive: true, force: true })
})

describe('migrateToHostIdentity', () => {
  it('folds device-keyed pairings, git credentials, principals, directories, and tab stamps into the host subject', () => {
    const creds = credentialsStore()
    creds.add({ clientId: 'old-laptop', secret: randomBytes(32), scopes: ['admin'], subject: 'paired:dev-1', kind: 'desktop' })
    creds.add({ clientId: 'phone', secret: randomBytes(32), scopes: ['conversations:read'], subject: 'paired:phone', kind: 'mobile' })
    creds.add({ clientId: 'alice', secret: randomBytes(32), scopes: ['admin'], subject: 'oidc:alice', kind: 'desktop' })

    const git = gitCredentialStore()
    git.set({ subject: 'paired:dev-1', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'k1', publicKey: 'pub1' })
    git.set({ subject: 'paired:phone', host: 'gitlab.com', source: 'user', kind: 'https-token', token: 't', username: 'me' })

    const oldDir = join(dir, 'principals', principalDir('paired:dev-1'), 'git', 'github.com')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'id_ed25519'), 'k1\n')

    writeFileSync(join(dir, 'tabs.json'), JSON.stringify({ tabs: [{ id: 't1', principalSubject: 'paired:dev-1' }, { id: 't2', principalSubject: 'oidc:alice' }], settledHistory: [{ id: 't3', principalSubject: 'paired:phone' }] }))
    writeFileSync(join(dir, 'studio-terminals.json'), JSON.stringify({ version: 1, terminals: [{ key: 'k', principalSubject: 'paired:dev-1' }] }))

    const result = migrateToHostIdentity(dir, HOST)

    expect(result.pairings.sort()).toEqual(['old-laptop', 'phone'])
    expect(creds.get('old-laptop')?.subject).toBe(HOST)
    expect(creds.get('phone')?.subject).toBe(HOST)
    expect(creds.get('alice')?.subject).toBe('oidc:alice')

    expect(result.gitHosts.sort()).toEqual(['github.com', 'gitlab.com'])
    expect(git.listFor(HOST).map((c) => c.host).sort()).toEqual(['github.com', 'gitlab.com'])
    expect(git.listFor('paired:dev-1')).toEqual([])
    expect(git.privateKeyFor(HOST, 'github.com')).toBe('k1')

    expect(lookupPrincipal(HOST)?.displayName).toBe('tester')
    expect(result.principalDirs).toEqual([principalDir('paired:dev-1')])
    expect(existsSync(join(dir, 'principals', principalDir(HOST), 'git', 'github.com', 'id_ed25519'))).toBe(true)
    expect(existsSync(join(dir, 'principals', principalDir('paired:dev-1')))).toBe(false)

    const tabs = JSON.parse(readFileSync(join(dir, 'tabs.json'), 'utf-8')) as { tabs: Array<{ principalSubject: string }>; settledHistory: Array<{ principalSubject: string }> }
    expect(tabs.tabs.map((t) => t.principalSubject)).toEqual([HOST, 'oidc:alice'])
    expect(tabs.settledHistory[0].principalSubject).toBe(HOST)
    expect(existsSync(join(dir, 'tabs.json.pre-host-identity.bak'))).toBe(true)
    expect(result).toMatchObject({ tabs: 2, terminals: 1 })
  })

  it('keeps the host subject\'s newer credential when a device held one for the same git host', () => {
    const git = gitCredentialStore()
    git.set({ subject: 'paired:dev-1', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'old', publicKey: 'old' })
    git.set({ subject: HOST, host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'new', publicKey: 'new' })
    migrateToHostIdentity(dir, HOST)
    expect(git.privateKeyFor(HOST, 'github.com')).toBe('new')
    expect(git.listFor('paired:dev-1')).toEqual([])
  })

  it('is idempotent: a second pass on a folded data dir changes nothing', () => {
    credentialsStore().add({ clientId: 'c', secret: randomBytes(32), scopes: ['admin'], subject: 'paired:dev-1', kind: 'desktop' })
    migrateToHostIdentity(dir, HOST)
    const second = migrateToHostIdentity(dir, HOST)
    expect(second).toEqual({ pairings: [], gitHosts: [], principals: [], principalDirs: [], tabs: 0, terminals: 0 })
  })
})
