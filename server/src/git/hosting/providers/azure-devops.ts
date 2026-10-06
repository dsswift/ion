/**
 * Azure DevOps Services. A repository lives in a project of an
 * organization, so an owner is `organization/project`, and its visibility
 * is the project's. A new repository there is empty, so the README commit is
 * pushed through the API right after it is created.
 */
import type { GitHostingOwner } from '@ion/shared/types-git-hosting'
import type { GitHostingAuth, GitHostingProvider, GitHostingTarget } from '../types'
import { GitHostingError } from '../types'
import { hostingCall, record, text, type HostingCall } from '../http'
import { warn as _warn } from '../../../logger'

function warn(msg: string, fields?: Record<string, unknown>): void { _warn('git-hosting', msg, fields) }

const API_VERSION = 'api-version=7.1'
/** The identity service every organization shares: who the token is, and which organizations they are in. */
const IDENTITY_BASE_URL = 'https://app.vssps.visualstudio.com'
const DEFAULT_BRANCH = 'main'
const NO_COMMIT = '0000000000000000000000000000000000000000'

/**
 * A personal access token is sent as a Basic password; a token Entra issued
 * (the on-behalf-of exchange, or `az`) is a Bearer. Which one a credential
 * holds follows from where it came from: a person or operator can only
 * store a PAT.
 */
function authorization(auth: GitHostingAuth): string {
  if (auth.source === 'user' || auth.source === 'admin') return `Basic ${Buffer.from(`:${auth.token}`).toString('base64')}`
  return `Bearer ${auth.token}`
}

function call(target: GitHostingTarget, auth: GitHostingAuth, operation: string, url: string, body?: unknown): HostingCall {
  return {
    provider: 'azure-devops',
    host: target.host,
    operation,
    url,
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: authorization(auth) },
    body,
    // A signed-out or under-scoped token is answered with a sign-in page, not JSON.
    errorMessage: (parsed, status) => text(parsed, 'message') || (status === 401 || status === 203 ? 'Azure DevOps did not accept the credential.' : null),
  }
}

function values(body: unknown): unknown[] {
  const list = record(body).value
  return Array.isArray(list) ? list : []
}

async function profile(target: GitHostingTarget, auth: GitHostingAuth): Promise<{ id: string; name: string }> {
  const me = await hostingCall<unknown>(call(target, auth, 'account', `${IDENTITY_BASE_URL}/_apis/profile/profiles/me?${API_VERSION}`))
  const id = text(me, 'id')
  if (!id) throw new GitHostingError(401, 'Azure DevOps did not accept the credential.')
  return { id, name: text(me, 'emailAddress') || text(me, 'displayName') }
}

export const azureDevopsProvider: GitHostingProvider = {
  kind: 'azure-devops',
  choosesVisibility: false,
  defaultApiBaseUrl: (host) => `https://${host}`,
  account: async (target, auth) => (await profile(target, auth)).name,

  owners: async (target, auth) => {
    const me = await profile(target, auth)
    const organizations = values(await hostingCall<unknown>(call(target, auth, 'owners', `${IDENTITY_BASE_URL}/_apis/accounts?memberId=${encodeURIComponent(me.id)}&${API_VERSION}`)))
      .map((a) => text(a, 'accountName')).filter((n) => n).sort()
    const perOrganization = await Promise.all(organizations.map(async (organization): Promise<GitHostingOwner[]> => {
      try {
        const projects = values(await hostingCall<unknown>(call(target, auth, 'owners', `${target.apiBaseUrl}/${encodeURIComponent(organization)}/_apis/projects?$top=500&${API_VERSION}`)))
        return projects.map((p) => text(p, 'name')).filter((n) => n).sort().map((project) => ({ id: `${organization}/${project}`, label: `${organization}/${project}`, kind: 'project' }))
      } catch (err) {
        // One organization that refuses the token (a conditional-access policy, say) must not hide the others.
        warn('azure devops organization skipped: its projects could not be listed', { organization, error: String(err) })
        return []
      }
    }))
    return perOrganization.flat()
  },

  createRepository: async (target, auth, request) => {
    const slash = request.owner.indexOf('/')
    if (slash <= 0) throw new GitHostingError(400, 'An Azure DevOps repository needs an organization and a project.')
    const organization = request.owner.slice(0, slash)
    const project = request.owner.slice(slash + 1)
    const base = `${target.apiBaseUrl}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories`
    const created = await hostingCall<unknown>(call(target, auth, 'create', `${base}?${API_VERSION}`, { name: request.name }))
    const id = text(created, 'id')
    const readme = `# ${request.name}\n${request.description ? `\n${request.description}\n` : ''}`
    await hostingCall<unknown>(call(target, auth, 'create-readme', `${base}/${encodeURIComponent(id)}/pushes?${API_VERSION}`, {
      refUpdates: [{ name: `refs/heads/${DEFAULT_BRANCH}`, oldObjectId: NO_COMMIT }],
      commits: [{ comment: 'Initial commit', changes: [{ changeType: 'add', item: { path: '/README.md' }, newContent: { content: readme, contentType: 'rawtext' } }] }],
    }))
    return {
      host: target.host,
      provider: 'azure-devops',
      owner: request.owner,
      name: text(created, 'name') || request.name,
      webUrl: text(created, 'webUrl'),
      sshUrl: text(created, 'sshUrl'),
      httpsUrl: text(created, 'remoteUrl'),
      defaultBranch: DEFAULT_BRANCH,
    }
  },
}
