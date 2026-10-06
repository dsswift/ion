/**
 * GitLab, SaaS or self-managed. A repository is a "project" there, created
 * in the account's own namespace or in a group where the account is at
 * least a Developer.
 */
import type { GitHostingOwner } from '@ion/shared/types-git-hosting'
import type { GitHostingAuth, GitHostingProvider, GitHostingTarget } from '../types'
import { hostingCall, record, text, type HostingCall } from '../http'

const PAGE = 100
const MAX_PAGES = 10
/** Developer: the lowest group role that can be allowed to create projects. */
const MIN_ACCESS_LEVEL = 30

/** GitLab's message is a string, a list, or a map of field to problems. */
function flatten(message: unknown): string {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return message.map(flatten).filter((m) => m).join('; ')
  return Object.entries(record(message)).map(([field, problems]) => `${field} ${flatten(problems)}`).join('; ')
}

function errorMessage(body: unknown, status: number): string | null {
  if (status === 403 && text(body, 'error') === 'insufficient_scope') return 'Sign in to GitLab again to allow creating projects.'
  return flatten(record(body).message) || text(body, 'error_description') || text(body, 'error') || null
}

function call(target: GitHostingTarget, auth: GitHostingAuth, operation: string, path: string, body?: unknown): HostingCall {
  return {
    provider: 'gitlab',
    host: target.host,
    operation,
    url: `${target.apiBaseUrl}${path}`,
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${auth.token}` },
    body,
    errorMessage,
  }
}

async function username(target: GitHostingTarget, auth: GitHostingAuth): Promise<string> {
  return text(await hostingCall<unknown>(call(target, auth, 'account', '/user')), 'username')
}

export const gitlabProvider: GitHostingProvider = {
  kind: 'gitlab',
  choosesVisibility: true,
  defaultApiBaseUrl: (host) => `https://${host}/api/v4`,
  account: username,

  owners: async (target, auth) => {
    const me = await username(target, auth)
    const groups: GitHostingOwner[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await hostingCall<unknown>(call(target, auth, 'owners', `/groups?min_access_level=${MIN_ACCESS_LEVEL}&per_page=${PAGE}&page=${page}`))
      const list = Array.isArray(batch) ? batch : []
      groups.push(...list.map((g): GitHostingOwner => ({ id: `group:${String(record(g).id ?? '')}`, label: text(g, 'full_path'), kind: 'group' })))
      if (list.length < PAGE) break
    }
    return [{ id: `user:${me}`, label: me, kind: 'user' }, ...groups]
  },

  createRepository: async (target, auth, request) => {
    const [kind, id] = request.owner.split(':', 2)
    const created = await hostingCall<unknown>(call(target, auth, 'create', '/projects', {
      name: request.name,
      path: request.name,
      visibility: request.visibility,
      initialize_with_readme: true,
      ...(kind === 'group' ? { namespace_id: Number(id) } : {}),
      ...(request.description ? { description: request.description } : {}),
    }))
    return {
      host: target.host,
      provider: 'gitlab',
      owner: text(record(created).namespace, 'full_path') || id,
      name: text(created, 'path') || request.name,
      webUrl: text(created, 'web_url'),
      sshUrl: text(created, 'ssh_url_to_repo'),
      httpsUrl: text(created, 'http_url_to_repo'),
      defaultBranch: text(created, 'default_branch') || 'main',
    }
  },
}
