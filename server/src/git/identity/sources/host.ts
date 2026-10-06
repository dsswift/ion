/**
 * The `host` git credential source: the token of a git-host CLI the host
 * user is signed in to (`host-cli.ts`). The resolver consults it last, and
 * only for a caller that can use a token (an HTTPS remote, or a git host's
 * API), so a person's own Ion credential always wins and an SSH remote never
 * costs a CLI call. `server.json.git.hostCredentials: false` switches it
 * off, for a server whose host user's sign-ins must not serve everyone.
 */
import { isAdoHost } from './exchange-ado'
import { ADO_CLI_HOST, listHostCliSignIns, readHostCliToken, type HostCliSignIn, type HostCliTokenReader } from '../host-cli'
import type { GitCredentialLookup, GitCredentialSourceProvider } from '../types'
import { log as _log } from '../../../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('git-identity-host', msg, fields) }

/** How long a CLI's answer is reused. Short: `az` tokens expire within the hour, and a sign-out should be noticed soon. */
const TOKEN_TTL_MS = 5 * 60_000

/** The username git presents beside each CLI's token. */
const TOKEN_USERNAME: Record<HostCliSignIn['tool'], string> = { gh: 'x-access-token', glab: 'oauth2', az: 'oauth2' }

export interface HostSourceOptions {
  enabled: () => boolean
  signIns?: () => HostCliSignIn[]
  readToken?: HostCliTokenReader
  now?: () => number
}

export function hostCredentialSource(options: HostSourceOptions): GitCredentialSourceProvider {
  const signIns = options.signIns ?? (() => listHostCliSignIns())
  const readToken = options.readToken ?? readHostCliToken
  const now = options.now ?? Date.now
  const cache = new Map<string, { token: string | null; expiresAt: number }>()
  return {
    name: 'host',
    resolve: async (_subject, host): Promise<GitCredentialLookup> => {
      if (!options.enabled()) { log('host credentials disabled by config', { git_host: host }); return null }
      const signIn = signIns().find((s) => s.host === host || (s.host === ADO_CLI_HOST && isAdoHost(host)))
      if (!signIn) return null
      const key = `${signIn.tool} ${signIn.host}`
      let held = cache.get(key)
      if (!held || now() >= held.expiresAt) {
        held = { token: await readToken(signIn), expiresAt: now() + TOKEN_TTL_MS }
        cache.set(key, held)
      }
      if (!held.token) return null
      return { source: 'host', kind: 'https-token', host, token: held.token, username: TOKEN_USERNAME[signIn.tool] }
    },
  }
}
