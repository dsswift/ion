/**
 * GitHub and GitHub Enterprise Server. A personal or CLI token lists the
 * account's organizations; a GitHub App's user token (the `exchange-github`
 * credential) can only act where the App is installed, so it lists those
 * installations instead.
 */
import type { GitHostingOwner, GitHostingRepository } from '@ion/shared/types-git-hosting'
import type { GitHostingAuth, GitHostingProvider, GitHostingTarget } from '../types'
import { hostingCall, record, text, type HostingCall } from '../http'

const PAGE = 100
const MAX_PAGES = 10

function errorMessage(body: unknown): string | null {
  const message = text(body, 'message')
  const details = record(body).errors
  const first = Array.isArray(details) ? details.map((d) => text(d, 'message')).find((m) => m) : undefined
  if (!message) return null
  return first ? `${message}: ${first}` : message
}

function call(target: GitHostingTarget, auth: GitHostingAuth, operation: string, path: string, body?: unknown): HostingCall {
  return {
    provider: 'github',
    host: target.host,
    operation,
    url: `${target.apiBaseUrl}${path}`,
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ion' },
    body,
    errorMessage,
  }
}

/** Every page of a list endpoint, up to a bound no real account reaches. */
async function pages<T>(target: GitHostingTarget, auth: GitHostingAuth, operation: string, path: string, items: (body: unknown) => T[]): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = items(await hostingCall<unknown>(call(target, auth, operation, `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`)))
    all.push(...batch)
    if (batch.length < PAGE) break
  }
  return all
}

async function login(target: GitHostingTarget, auth: GitHostingAuth): Promise<string> {
  return text(await hostingCall<unknown>(call(target, auth, 'account', '/user')), 'login')
}

export const githubProvider: GitHostingProvider = {
  kind: 'github',
  choosesVisibility: true,
  defaultApiBaseUrl: (host) => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`),
  account: login,

  owners: async (target, auth) => {
    const me = await login(target, auth)
    const own: GitHostingOwner = { id: `user:${me}`, label: me, kind: 'user' }
    if (auth.source === 'exchange-github') {
      const installed = await pages(target, auth, 'owners', '/user/installations', (body) => {
        const list = record(body).installations
        return Array.isArray(list) ? list.map((i) => record(record(i).account)) : []
      })
      const orgs = installed.filter((a) => a.type === 'Organization').map((a): GitHostingOwner => ({ id: `org:${text(a, 'login')}`, label: text(a, 'login'), kind: 'org' }))
      const personal = installed.some((a) => a.type === 'User' && text(a, 'login') === me)
      return [...(personal ? [own] : []), ...orgs]
    }
    const orgs = await pages(target, auth, 'owners', '/user/orgs', (body) => (Array.isArray(body) ? body.map((o) => text(o, 'login')).filter((l) => l) : []))
    return [own, ...orgs.map((org): GitHostingOwner => ({ id: `org:${org}`, label: org, kind: 'org' }))]
  },

  createRepository: async (target, auth, request) => {
    const [kind, owner] = request.owner.split(':', 2)
    const path = kind === 'org' ? `/orgs/${encodeURIComponent(owner)}/repos` : '/user/repos'
    const created = await hostingCall<unknown>(call(target, auth, 'create', path, {
      name: request.name,
      private: request.visibility === 'private',
      auto_init: true,
      ...(request.description ? { description: request.description } : {}),
    }))
    const repository: GitHostingRepository = {
      host: target.host,
      provider: 'github',
      owner: text(record(created).owner, 'login') || owner,
      name: text(created, 'name') || request.name,
      webUrl: text(created, 'html_url'),
      sshUrl: text(created, 'ssh_url'),
      httpsUrl: text(created, 'clone_url'),
      defaultBranch: text(created, 'default_branch') || 'main',
    }
    return repository
  },
}
