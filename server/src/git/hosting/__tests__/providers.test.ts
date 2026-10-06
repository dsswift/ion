/** Hosting providers — each host's account, owners and repository creation, against a stubbed fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubProvider } from '../providers/github'
import { gitlabProvider } from '../providers/gitlab'
import { azureDevopsProvider } from '../providers/azure-devops'
import type { GitHostingAuth } from '../types'

interface Seen { method: string; url: string; headers: Record<string, string>; body: unknown }
let seen: Seen[]
let routes: Array<{ match: (s: Seen) => boolean; status?: number; body: unknown }>

function route(method: string, urlPart: string, body: unknown, status = 200): void {
  routes.push({ match: (s) => s.method === method && s.url.includes(urlPart), status, body })
}

beforeEach(() => {
  seen = []
  routes = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Seen = { method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined }
    seen.push(call)
    const hit = routes.find((r) => r.match(call))
    if (!hit) return new Response(JSON.stringify({ message: `no route for ${call.method} ${url}` }), { status: 404 })
    return new Response(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body), { status: hit.status ?? 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const cli: GitHostingAuth = { token: 'TOKEN', source: 'host' }

describe('githubProvider', () => {
  const target = { host: 'github.com', apiBaseUrl: 'https://api.github.com' }

  it('uses the enterprise api path for any other host', () => {
    expect(githubProvider.defaultApiBaseUrl('github.com')).toBe('https://api.github.com')
    expect(githubProvider.defaultApiBaseUrl('github.example.org')).toBe('https://github.example.org/api/v3')
  })

  it('lists the account first, then its organizations', async () => {
    route('GET', '/user/orgs', [{ login: 'example-org' }, { login: 'other-org' }])
    route('GET', '/user', { login: 'example-user' })
    expect(await githubProvider.account(target, cli)).toBe('example-user')
    expect(await githubProvider.owners(target, cli)).toEqual([
      { id: 'user:example-user', label: 'example-user', kind: 'user' },
      { id: 'org:example-org', label: 'example-org', kind: 'org' },
      { id: 'org:other-org', label: 'other-org', kind: 'org' },
    ])
    expect(seen[0].headers.Authorization).toBe('Bearer TOKEN')
  })

  it('lists only where the app is installed for an app sign-in token', async () => {
    route('GET', '/user/installations', { installations: [{ account: { login: 'example-org', type: 'Organization' } }] })
    route('GET', '/user', { login: 'example-user' })
    expect(await githubProvider.owners(target, { token: 'T', source: 'exchange-github' })).toEqual([{ id: 'org:example-org', label: 'example-org', kind: 'org' }])
    expect(seen.some((s) => s.url.includes('/user/orgs'))).toBe(false)
  })

  it('creates an organization repository with a first commit', async () => {
    route('POST', '/orgs/example-org/repos', { name: 'app', owner: { login: 'example-org' }, html_url: 'https://github.com/example-org/app', ssh_url: 'git@github.com:example-org/app.git', clone_url: 'https://github.com/example-org/app.git', default_branch: 'main' }, 201)
    const repo = await githubProvider.createRepository(target, cli, { host: 'github.com', owner: 'org:example-org', name: 'app', visibility: 'private', description: 'An app' })
    expect(seen[0].body).toEqual({ name: 'app', private: true, auto_init: true, description: 'An app' })
    expect(repo).toEqual({ host: 'github.com', provider: 'github', owner: 'example-org', name: 'app', webUrl: 'https://github.com/example-org/app', sshUrl: 'git@github.com:example-org/app.git', httpsUrl: 'https://github.com/example-org/app.git', defaultBranch: 'main' })
  })

  it('creates a personal repository under the account, and reports the host\'s own refusal', async () => {
    route('POST', '/user/repos', { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }, 422)
    await expect(githubProvider.createRepository(target, cli, { host: 'github.com', owner: 'user:example-user', name: 'app', visibility: 'public' }))
      .rejects.toThrow('Repository creation failed.: name already exists on this account')
    expect(seen[0].body).toEqual({ name: 'app', private: false, auto_init: true })
  })
})

describe('gitlabProvider', () => {
  const target = { host: 'gitlab.com', apiBaseUrl: 'https://gitlab.com/api/v4' }

  it('lists the account, then the groups it can create projects in', async () => {
    route('GET', '/groups?min_access_level=30', [{ id: 42, full_path: 'example-group/platform' }])
    route('GET', '/user', { username: 'example-user' })
    expect(await gitlabProvider.owners(target, cli)).toEqual([
      { id: 'user:example-user', label: 'example-user', kind: 'user' },
      { id: 'group:42', label: 'example-group/platform', kind: 'group' },
    ])
  })

  it('creates a project in a group with a README', async () => {
    route('POST', '/projects', { path: 'app', namespace: { full_path: 'example-group/platform' }, web_url: 'https://gitlab.com/example-group/platform/app', ssh_url_to_repo: 'git@gitlab.com:example-group/platform/app.git', http_url_to_repo: 'https://gitlab.com/example-group/platform/app.git', default_branch: 'main' }, 201)
    const repo = await gitlabProvider.createRepository(target, cli, { host: 'gitlab.com', owner: 'group:42', name: 'app', visibility: 'private' })
    expect(seen[0].body).toEqual({ name: 'app', path: 'app', visibility: 'private', initialize_with_readme: true, namespace_id: 42 })
    expect(repo.owner).toBe('example-group/platform')
    expect(repo.sshUrl).toBe('git@gitlab.com:example-group/platform/app.git')
  })

  it('leaves the namespace out for the account\'s own space', async () => {
    route('POST', '/projects', { path: 'app' }, 201)
    await gitlabProvider.createRepository(target, cli, { host: 'gitlab.com', owner: 'user:example-user', name: 'app', visibility: 'public' })
    expect(seen[0].body).toEqual({ name: 'app', path: 'app', visibility: 'public', initialize_with_readme: true })
  })

  it('asks for a fresh sign-in when the token predates the api scope', async () => {
    route('POST', '/projects', { error: 'insufficient_scope', error_description: 'The request requires higher privileges than provided by the access token.' }, 403)
    await expect(gitlabProvider.createRepository(target, { token: 'T', source: 'exchange-gitlab' }, { host: 'gitlab.com', owner: 'user:example-user', name: 'app', visibility: 'private' }))
      .rejects.toThrow('Sign in to GitLab again to allow creating projects.')
  })

  it('reports a field problem in the host\'s own words', async () => {
    route('POST', '/projects', { message: { name: ['has already been taken'] } }, 400)
    await expect(gitlabProvider.createRepository(target, cli, { host: 'gitlab.com', owner: 'user:example-user', name: 'app', visibility: 'private' }))
      .rejects.toThrow('name has already been taken')
  })
})

describe('azureDevopsProvider', () => {
  const target = { host: 'dev.azure.com', apiBaseUrl: 'https://dev.azure.com' }

  it('lists every project of every organization, and skips an organization that refuses', async () => {
    route('GET', '/_apis/profile/profiles/me', { id: 'member-1', emailAddress: 'user@example.org' })
    route('GET', '/_apis/accounts?memberId=member-1', { value: [{ accountName: 'example-org' }, { accountName: 'closed-org' }] })
    route('GET', '/example-org/_apis/projects', { value: [{ name: 'Platform' }, { name: 'Apps' }] })
    route('GET', '/closed-org/_apis/projects', { message: 'Access denied' }, 403)
    expect(await azureDevopsProvider.account(target, cli)).toBe('user@example.org')
    expect(await azureDevopsProvider.owners(target, cli)).toEqual([
      { id: 'example-org/Apps', label: 'example-org/Apps', kind: 'project' },
      { id: 'example-org/Platform', label: 'example-org/Platform', kind: 'project' },
    ])
  })

  it('sends an Entra token as a bearer and a stored token as a basic password', async () => {
    route('GET', '/_apis/profile/profiles/me', { id: 'member-1', displayName: 'A User' })
    await azureDevopsProvider.account(target, cli)
    await azureDevopsProvider.account(target, { token: 'PAT', source: 'user' })
    expect(seen[0].headers.Authorization).toBe('Bearer TOKEN')
    expect(seen[1].headers.Authorization).toBe(`Basic ${Buffer.from(':PAT').toString('base64')}`)
  })

  it('creates the repository, then pushes the README commit it does not start with', async () => {
    route('POST', '/pushes', {}, 201)
    route('POST', '/example-org/Platform/_apis/git/repositories', { id: 'repo-1', name: 'app', webUrl: 'https://dev.azure.com/example-org/Platform/_git/app', sshUrl: 'git@ssh.dev.azure.com:v3/example-org/Platform/app', remoteUrl: 'https://example-org@dev.azure.com/example-org/Platform/_git/app' }, 201)
    const repo = await azureDevopsProvider.createRepository(target, cli, { host: 'dev.azure.com', owner: 'example-org/Platform', name: 'app', visibility: 'private', description: 'An app' })
    expect(seen[0].body).toEqual({ name: 'app' })
    expect(seen[1].url).toContain('/repositories/repo-1/pushes')
    expect(seen[1].body).toEqual({
      refUpdates: [{ name: 'refs/heads/main', oldObjectId: '0000000000000000000000000000000000000000' }],
      commits: [{ comment: 'Initial commit', changes: [{ changeType: 'add', item: { path: '/README.md' }, newContent: { content: '# app\n\nAn app\n', contentType: 'rawtext' } }] }],
    })
    expect(repo).toEqual({ host: 'dev.azure.com', provider: 'azure-devops', owner: 'example-org/Platform', name: 'app', webUrl: 'https://dev.azure.com/example-org/Platform/_git/app', sshUrl: 'git@ssh.dev.azure.com:v3/example-org/Platform/app', httpsUrl: 'https://example-org@dev.azure.com/example-org/Platform/_git/app', defaultBranch: 'main' })
  })

  it('reports a sign-in page as a refused credential', async () => {
    route('GET', '/_apis/profile/profiles/me', '<html>Sign in</html>', 203)
    await expect(azureDevopsProvider.account(target, cli)).rejects.toThrow('Azure DevOps did not accept the credential.')
  })
})
