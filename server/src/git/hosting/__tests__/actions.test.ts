/** gitHosting.* — accounts come from every host the person has a token for; creation validates, then asks the host's provider. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Connection } from '../../../protocol/connection'
import { setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../../config/current'
import { loadServerConfig } from '../../../config/server-config'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../../identity/credential-store'
import { _resetResolverSourcesForTest, _setHostSourceForTest } from '../../identity/resolver'
import { GIT_HOSTING_ACTIONS } from '../actions'
import { gitHostingHosts } from '../registry'
import { registeredActionSpec } from '../../../protocol/actions'

let dir: string
const conn = { id: 'c1', principal: { subject: 'oidc:alice' } } as unknown as Connection
const run = (name: string, args: unknown[] = []) => GIT_HOSTING_ACTIONS[name].handler(conn, args)

function respond(routes: Record<string, { status?: number; body: unknown }>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((part) => url.includes(part))
    const hit = key ? routes[key] : { status: 404, body: { message: 'not found' } }
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 })
  }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-git-hosting-'))
  _resetGitCredentialStoreForTest(dir)
  _resetResolverSourcesForTest()
  setCurrentServerConfig(loadServerConfig(dir))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
  _resetCurrentServerConfigForTest()
  _resetResolverSourcesForTest()
})

describe('gitHostingHosts', () => {
  it('knows the three hosted services, and adds configured self-managed hosts', () => {
    expect(gitHostingHosts().map((h) => [h.host, h.provider.kind, h.apiBaseUrl])).toEqual([
      ['github.com', 'github', 'https://api.github.com'],
      ['gitlab.com', 'gitlab', 'https://gitlab.com/api/v4'],
      ['dev.azure.com', 'azure-devops', 'https://dev.azure.com'],
    ])
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ git: { hosts: [
      { host: 'gitlab.example.org', provider: 'gitlab' },
      { host: 'github.example.org', provider: 'github', apiBaseUrl: 'https://github.example.org/api/v3/' },
      { host: 'bad.example.org', provider: 'gitea' },
    ] } }))
    setCurrentServerConfig(loadServerConfig(dir))
    expect(gitHostingHosts().slice(3).map((h) => [h.host, h.provider.kind, h.apiBaseUrl])).toEqual([
      ['gitlab.example.org', 'gitlab', 'https://gitlab.example.org/api/v4'],
      ['github.example.org', 'github', 'https://github.example.org/api/v3'],
    ])
  })
})

describe('gitHosting.accounts', () => {
  it('is registered, and needs git:write', () => {
    expect(registeredActionSpec('gitHosting.accounts')?.requiredScope).toBe('git:write')
    expect(registeredActionSpec('gitHosting.createRepository')?.requiredScope).toBe('git:write')
  })

  it('lists nothing for a person with no token anywhere', async () => {
    expect(await run('gitHosting.accounts')).toEqual({ ok: true, value: [] })
  })

  it('lists each host with a token, a stored token ahead of the host\'s cli, and keeps a failing host as an error', async () => {
    gitCredentialStore().set({ subject: 'oidc:alice', host: 'gitlab.com', source: 'user', kind: 'https-token', token: 'STORED', username: 'alice' })
    _setHostSourceForTest({ name: 'host', resolve: (_s, host) => (host === 'dev.azure.com' ? null : { source: 'host', kind: 'https-token', host, token: 'CLI' }) })
    respond({
      'api.github.com/user/orgs': { body: [{ login: 'example-org' }] },
      'api.github.com/user': { body: { login: 'example-user' } },
      'gitlab.com/api/v4/user': { status: 401, body: { message: '401 Unauthorized' } },
    })
    const outcome = await run('gitHosting.accounts')
    expect(outcome).toEqual({ ok: true, value: [
      { host: 'github.com', provider: 'github', account: 'example-user', credentialSource: 'host', choosesVisibility: true, owners: [
        { id: 'user:example-user', label: 'example-user', kind: 'user' },
        { id: 'org:example-org', label: 'example-org', kind: 'org' },
      ] },
      { host: 'gitlab.com', provider: 'gitlab', account: '', credentialSource: 'user', choosesVisibility: true, owners: [], error: '401 Unauthorized' },
    ] })
  })

  it('refuses a connection with no principal', async () => {
    const outcome = await GIT_HOSTING_ACTIONS['gitHosting.accounts'].handler({ id: 'c2', principal: null } as unknown as Connection, [])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'no_principal' } })
  })
})

describe('gitHosting.createRepository', () => {
  const request = { host: 'github.com', owner: 'org:example-org', name: 'app', visibility: 'private' }

  it('refuses a bad name, an unknown host, and a host with no token, before any call', async () => {
    respond({})
    expect(await run('gitHosting.createRepository', [{ ...request, name: 'my app' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await run('gitHosting.createRepository', [{ ...request, visibility: 'secret' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await run('gitHosting.createRepository', [{ ...request, host: 'git.example.org' }])).toMatchObject({ ok: false, error: { code: 'unknown_host' } })
    expect(await run('gitHosting.createRepository', [request])).toMatchObject({ ok: false, error: { code: 'no_credential' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('creates through the host\'s provider and returns both clone urls', async () => {
    _setHostSourceForTest({ name: 'host', resolve: (_s, host) => ({ source: 'host', kind: 'https-token', host, token: 'CLI' }) })
    respond({ '/orgs/example-org/repos': { status: 201, body: { name: 'app', owner: { login: 'example-org' }, html_url: 'https://github.com/example-org/app', ssh_url: 'git@github.com:example-org/app.git', clone_url: 'https://github.com/example-org/app.git', default_branch: 'main' } } })
    expect(await run('gitHosting.createRepository', [request])).toEqual({ ok: true, value: {
      host: 'github.com', provider: 'github', owner: 'example-org', name: 'app', webUrl: 'https://github.com/example-org/app',
      sshUrl: 'git@github.com:example-org/app.git', httpsUrl: 'https://github.com/example-org/app.git', defaultBranch: 'main',
    } })
  })

  it('reports the host\'s refusal as the error', async () => {
    _setHostSourceForTest({ name: 'host', resolve: (_s, host) => ({ source: 'host', kind: 'https-token', host, token: 'CLI' }) })
    respond({ '/orgs/example-org/repos': { status: 403, body: { message: 'You need admin access to the organization before adding a repository to it.' } } })
    expect(await run('gitHosting.createRepository', [request])).toEqual({ ok: false, error: { code: 'create_failed', message: 'You need admin access to the organization before adding a repository to it.' } })
  })
})
