/** chooseCloneUrl — each host clones by the URL its own credentials fit. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../config/current'
import { loadServerConfig } from '../../config/server-config'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../../git/identity/credential-store'
import { _resetResolverSourcesForTest, _setHostSourceForTest } from '../../git/identity/resolver'
import { chooseCloneUrl } from '../clone-url'

const remote = { sshUrl: 'git@github.com:example-org/app.git', httpsUrl: 'https://github.com/example-org/app.git' }
const realHome = process.env.HOME
let dir: string
let home: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-clone-url-'))
  home = join(dir, 'home')
  mkdirSync(home)
  process.env.HOME = home
  _resetGitCredentialStoreForTest(dir)
  _resetResolverSourcesForTest()
  setCurrentServerConfig(loadServerConfig(dir))
})
afterEach(() => {
  process.env.HOME = realHome
  rmSync(dir, { recursive: true, force: true })
  _resetCurrentServerConfigForTest()
  _resetResolverSourcesForTest()
})

function giveHostAKey(): void {
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA user@example.org\n')
}

describe('chooseCloneUrl', () => {
  it('uses ssh when Ion stores an ssh key for the person and host', async () => {
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'KEY', publicKey: 'PUB' })
    expect(await chooseCloneUrl('oidc:alice', remote)).toBe(remote.sshUrl)
  })

  it('uses https when Ion stores a token, even on a host with ssh keys', async () => {
    giveHostAKey()
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'github.com', source: 'user', kind: 'https-token', token: 'T', username: 'alice' })
    expect(await chooseCloneUrl('oidc:alice', remote)).toBe(remote.httpsUrl)
  })

  it('uses ssh when only the host has keys, even with a cli signed in', async () => {
    giveHostAKey()
    _setHostSourceForTest({ name: 'host', resolve: (_s, host) => ({ source: 'host', kind: 'https-token', host, token: 'CLI' }) })
    expect(await chooseCloneUrl('oidc:alice', remote)).toBe(remote.sshUrl)
    expect(await chooseCloneUrl(undefined, remote)).toBe(remote.sshUrl)
  })

  it('falls back to https on a host with no ssh key at all', async () => {
    expect(await chooseCloneUrl('oidc:alice', remote)).toBe(remote.httpsUrl)
  })
})
