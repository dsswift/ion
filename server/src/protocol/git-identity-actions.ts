/**
 * `gitIdentity.*` `studio_action`s (FR-04): a person managing their own git
 * credentials. Every handler resolves the acting subject from the
 * CONNECTION's resolved principal (`conn.principal.subject`), never from the
 * payload -- a client can only ever read/mint/set/remove its own
 * credentials, matching `settings-actions.ts`'s "subject comes from the
 * connection" convention.
 *
 * `gitIdentity.authorize` starts the GitLab/GitHub OAuth exchange by
 * broadcasting the authorize URL via `oauth/url-opener.ts` (`ion:open-auth-url`)
 * for an attached client to open; the exchange completes at
 * `GET /auth/git/callback` (`http/auth-git-callback.ts`). Azure DevOps needs
 * no separate authorize step (`exchange-ado.ts` runs on-behalf-of using an
 * already-signed-in browser session's own tokens), so `authorize` refuses a
 * `dev.azure.com`/`*.visualstudio.com` host with a clear explanation instead
 * of doing nothing silently.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import type { Connection } from './connection'
import { currentServerConfig } from '../config/current'
import { gitCredentialStore } from '../git/identity/credential-store'
import { listGitIdentitiesFor } from '../git/identity/list'
import { mintSshKeypair, removeUserCredential, setHttpsToken, setSshPrivateKey } from '../git/identity/sources/user-supplied'
import { beginGitlabAuthorize } from '../git/identity/sources/exchange-gitlab'
import { beginGithubAuthorize } from '../git/identity/sources/exchange-github'
import { isAdoHost } from '../git/identity/sources/exchange-ado'
import { openAuthUrl } from '../oauth/url-opener'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('git-identity-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('git-identity-actions', msg, fields)
}

export type GitIdentityActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

export interface GitIdentityActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<GitIdentityActionOutcome>
}

function subjectOf(conn: Connection): string {
  return conn.principal?.subject ?? ''
}

function firstArgObject(args: unknown[]): Record<string, unknown> {
  const a = args[0]
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
}

export const GIT_IDENTITY_ACTIONS: Record<string, GitIdentityActionSpec> = {
  'gitIdentity.list': {
    requiredScope: 'git:write',
    handler: async (conn) => {
      const subject = subjectOf(conn)
      if (!subject) return { ok: false, error: { code: 'no_principal', message: 'this connection has no resolved principal' } }
      return { ok: true, value: listGitIdentitiesFor(subject) }
    },
  },

  'gitIdentity.mintSshKey': {
    requiredScope: 'git:write',
    handler: async (conn, args) => {
      const subject = subjectOf(conn)
      const host = typeof firstArgObject(args).host === 'string' ? (firstArgObject(args).host as string) : ''
      if (!subject || !host) return { ok: false, error: { code: 'invalid_args', message: 'host is required' } }
      try {
        const result = await mintSshKeypair(gitCredentialStore(), subject, host)
        log('ssh keypair minted', { subject, git_host: host })
        return { ok: true, value: result }
      } catch (err) {
        warn('mintSshKey failed', { subject, git_host: host, error: String(err) })
        return { ok: false, error: { code: 'mint_failed', message: String(err) } }
      }
    },
  },

  'gitIdentity.setSshKey': {
    requiredScope: 'git:write',
    handler: async (conn, args) => {
      const a = firstArgObject(args)
      const subject = subjectOf(conn)
      const host = typeof a.host === 'string' ? a.host : ''
      const privateKey = typeof a.privateKey === 'string' ? a.privateKey : ''
      if (!subject || !host || !privateKey) return { ok: false, error: { code: 'invalid_args', message: 'host and privateKey are required' } }
      try {
        const result = await setSshPrivateKey(gitCredentialStore(), subject, host, privateKey)
        log('ssh private key set', { subject, git_host: host })
        return { ok: true, value: result }
      } catch (err) {
        return { ok: false, error: { code: 'invalid_key', message: String(err) } }
      }
    },
  },

  'gitIdentity.setToken': {
    requiredScope: 'git:write',
    handler: async (conn, args) => {
      const a = firstArgObject(args)
      const subject = subjectOf(conn)
      const host = typeof a.host === 'string' ? a.host : ''
      const token = typeof a.token === 'string' ? a.token : ''
      const username = typeof a.username === 'string' ? a.username : 'oauth2'
      if (!subject || !host || !token) return { ok: false, error: { code: 'invalid_args', message: 'host and token are required' } }
      setHttpsToken(gitCredentialStore(), subject, host, token, username)
      log('https token set', { subject, git_host: host })
      return { ok: true, value: { ok: true } }
    },
  },

  'gitIdentity.remove': {
    requiredScope: 'git:write',
    handler: async (conn, args) => {
      const a = firstArgObject(args)
      const subject = subjectOf(conn)
      const host = typeof a.host === 'string' ? a.host : ''
      if (!subject || !host) return { ok: false, error: { code: 'invalid_args', message: 'host is required' } }
      const removed = removeUserCredential(gitCredentialStore(), subject, host)
      return { ok: true, value: { removed } }
    },
  },

  'gitIdentity.authorize': {
    requiredScope: 'git:write',
    handler: async (conn, args) => {
      const a = firstArgObject(args)
      const subject = subjectOf(conn)
      const host = typeof a.host === 'string' ? a.host : ''
      if (!subject || !host) return { ok: false, error: { code: 'invalid_args', message: 'host is required' } }

      if (isAdoHost(host)) {
        return { ok: false, error: { code: 'no_authorize_needed', message: 'Azure DevOps needs no separate authorization: sign in to Studio in a browser tab and it is used automatically' } }
      }

      const git = currentServerConfig().git
      if (!git.publicOrigin) {
        warn('authorize refused: server.json.git.publicOrigin is not configured', { subject, git_host: host })
        return { ok: false, error: { code: 'not_configured', message: 'this server has no git.publicOrigin configured; an operator must set it to enable GitLab/GitHub authorization' } }
      }

      let authorizeUrl: string
      if (git.exchange.gitlab && new URL(git.exchange.gitlab.baseUrl).host === host) {
        authorizeUrl = beginGitlabAuthorize(git.exchange.gitlab, { origin: git.publicOrigin, subject }).url
      } else if (git.exchange.github && host === 'github.com') {
        authorizeUrl = beginGithubAuthorize(git.exchange.github, { origin: git.publicOrigin, subject }).url
      } else {
        return { ok: false, error: { code: 'exchange_not_configured', message: `no OAuth exchange is configured for host ${host}` } }
      }

      try {
        await openAuthUrl(authorizeUrl, conn)
      } catch (err) {
        return { ok: false, error: { code: 'no_client_attached', message: String(err) } }
      }
      log('authorize started', { subject, git_host: host, connection_id: conn.id, view: conn.view })
      return { ok: true, value: { started: true, authorizationUrl: authorizeUrl } }
    },
  },
}
