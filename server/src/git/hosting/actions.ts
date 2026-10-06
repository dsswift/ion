/**
 * `gitHosting.*` `studio_action`s: which git-host accounts this server can
 * act as for the calling person, creating a repository on one, and
 * starting a whole project from one (`start-project.ts`). The acting
 * subject is the connection's own principal, never an argument.
 */
import type { GitHostingAccount } from '@ion/shared/types-git-hosting'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import type { Connection } from '../../protocol/connection'
import { clientKey } from '../../protocol/parity-wrap'
import type { EnvironmentActionOutcome, EnvironmentActionSpec } from '../../environment/actions'
import { gitHostingHosts, type GitHostingHost } from './registry'
import { hostingToken } from './token'
import type { GitHostingAuth } from './types'
import { createRepositoryAs, GitHostingRefusal, message, parseCreateRequest } from './create'
import { startProject, StartProjectRefusal } from './start-project'
import { log as _log, warn as _warn } from '../../logger'

const TAG = 'git-hosting'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

const NO_PRINCIPAL: EnvironmentActionOutcome = { ok: false, error: { code: 'no_principal', message: 'this connection has no resolved principal' } }

/** One host's account and owners. A refusal is reported on the entry, so one failing host never hides the rest. */
async function accountOn(host: GitHostingHost, auth: GitHostingAuth): Promise<GitHostingAccount> {
  const entry: GitHostingAccount = { host: host.host, provider: host.provider.kind, account: '', credentialSource: auth.source, owners: [], choosesVisibility: host.provider.choosesVisibility }
  try {
    entry.account = await host.provider.account(host, auth)
    entry.owners = await host.provider.owners(host, auth)
  } catch (err) {
    entry.error = message(err)
  }
  return entry
}

/** Every git host the subject has a token for, with who it acts as there. */
export async function listHostingAccounts(subject: string): Promise<GitHostingAccount[]> {
  const accounts = await Promise.all(gitHostingHosts().map(async (host): Promise<GitHostingAccount | null> => {
    const auth = await hostingToken(subject, host.host)
    if (!auth) { log('no token for hosting host', { subject, git_host: host.host }); return null }
    return accountOn(host, auth)
  }))
  const held = accounts.filter((a): a is GitHostingAccount => a !== null)
  log('hosting accounts listed', { subject, hosts: held.map((a) => a.host), failed: held.filter((a) => a.error).map((a) => a.host) })
  return held
}

function firstArgObject(args: unknown[]): Record<string, unknown> {
  return args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : {}
}

function invalid(text: string): EnvironmentActionOutcome {
  return { ok: false, error: { code: 'invalid_args', message: text } }
}

export const GIT_HOSTING_ACTIONS: Record<string, EnvironmentActionSpec> = {
  'gitHosting.accounts': {
    requiredScope: 'git:write',
    handler: async (conn: Connection) => {
      const subject = conn.principal?.subject
      if (!subject) return NO_PRINCIPAL
      return { ok: true, value: await listHostingAccounts(subject) }
    },
  },

  'gitHosting.createRepository': {
    requiredScope: 'git:write',
    handler: async (conn: Connection, args) => {
      const subject = conn.principal?.subject
      if (!subject) return NO_PRINCIPAL
      const request = parseCreateRequest(firstArgObject(args))
      if (typeof request === 'string') return invalid(request)
      try {
        return { ok: true, value: await createRepositoryAs(subject, request) }
      } catch (err) {
        if (err instanceof GitHostingRefusal) return { ok: false, error: { code: err.code, message: err.message } }
        throw err
      }
    },
  },

  // [{ ...createRepository's fields, requestId, parentDir, prompt, model?, providerId?, profileId? }]
  //   -> { jobId, dir }. The `create` job does the rest; see start-project.ts.
  // It opens and prompts a conversation, so it needs conversations:operate as well.
  'gitHosting.startProject': {
    requiredScope: 'git:write',
    handler: async (conn: Connection, args) => {
      const subject = conn.principal?.subject
      if (!subject) return NO_PRINCIPAL
      if (!scopeSatisfies(conn.scopes, 'conversations:operate')) {
        warn('start project refused: missing conversations:operate', { connection_id: conn.id, subject })
        return { ok: false, refusal: { code: 'scope', message: 'gitHosting.startProject also requires scope conversations:operate' } }
      }
      const a = firstArgObject(args)
      const request = parseCreateRequest(a)
      if (typeof request === 'string') return invalid(request)
      const text = (key: string): string => (typeof a[key] === 'string' ? (a[key] as string).trim() : '')
      const requestId = text('requestId')
      const parentDir = text('parentDir')
      if (!requestId || !parentDir) return invalid('requestId and parentDir are required')
      if (a.prompt !== undefined && typeof a.prompt !== 'string') return invalid('prompt must be a string')
      try {
        return {
          ok: true,
          value: startProject(subject, {
            ...request, requestId, parentDir, prompt: typeof a.prompt === 'string' ? a.prompt : '',
            ...(text('model') ? { model: text('model') } : {}),
            ...(text('providerId') ? { providerId: text('providerId') } : {}),
            ...(text('profileId') ? { profileId: text('profileId') } : {}),
          }, { kind: 'caller', clientId: clientKey(conn), principalSubject: subject }),
        }
      } catch (err) {
        if (err instanceof StartProjectRefusal) return { ok: false, refusal: { code: 'start_refused', message: err.message } }
        throw err
      }
    },
  },
}
