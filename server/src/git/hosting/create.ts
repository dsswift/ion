/**
 * Creating a repository on a git host as one person: the request parse
 * every `gitHosting.*` create shares, and the call to the host's provider
 * with the person's own token.
 */
import type { GitHostingCreateRequest, GitHostingRepository } from '@ion/shared/types-git-hosting'
import { repositoryNameProblem } from '@ion/shared/types-git-hosting'
import { gitHostingHostFor } from './registry'
import { hostingToken } from './token'
import { log as _log, warn as _warn } from '../../logger'

const TAG = 'git-hosting'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** A create the server declined or the host refused, with the code a client reads. */
export class GitHostingRefusal extends Error {
  constructor(readonly code: 'unknown_host' | 'no_credential' | 'create_failed', message: string) {
    super(message)
  }
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The create request in `a`, or why it is not one. */
export function parseCreateRequest(a: Record<string, unknown>): GitHostingCreateRequest | string {
  const field = (key: string): string => (typeof a[key] === 'string' ? (a[key] as string).trim() : '')
  const host = field('host')
  const owner = field('owner')
  const name = field('name')
  if (!host || !owner) return 'host and owner are required'
  const problem = repositoryNameProblem(name)
  if (problem) return problem
  if (a.visibility !== 'private' && a.visibility !== 'public') return 'visibility must be private or public'
  const description = field('description')
  return { host, owner, name, visibility: a.visibility, ...(description ? { description } : {}) }
}

/** Creates the repository with `subject`'s token for its host. Throws `GitHostingRefusal`. */
export async function createRepositoryAs(subject: string, request: GitHostingCreateRequest): Promise<GitHostingRepository> {
  const host = gitHostingHostFor(request.host)
  if (!host) throw new GitHostingRefusal('unknown_host', `${request.host} is not a git host this server manages repositories on`)
  const auth = await hostingToken(subject, request.host)
  if (!auth) {
    warn('create refused: no token for host', { subject, git_host: request.host })
    throw new GitHostingRefusal('no_credential', `this server has no token for ${request.host}`)
  }
  try {
    const repository = await host.provider.createRepository(host, auth, request)
    log('repository created', { subject, git_host: request.host, provider: host.provider.kind, owner: repository.owner, name: repository.name, visibility: request.visibility, credential_source: auth.source })
    return repository
  } catch (err) {
    warn('repository creation failed', { subject, git_host: request.host, provider: host.provider.kind, owner: request.owner, name: request.name, error: message(err) })
    throw new GitHostingRefusal('create_failed', message(err))
  }
}
