/**
 * `server.json.git` -- the operator-managed git credentials, and the
 * OAuth-exchange applications this server uses to act as a person against
 * Azure DevOps, GitLab and GitHub.
 *
 * Split out of `server-config.ts`, which sits at the file-size cap: this is
 * its largest self-contained cluster, and the split matches the
 * `discovery-config.ts` and `tenancy-config.ts` modules beside it.
 */
import { warn as _warn } from '../logger'
import { resolveSecretRef } from './secret-ref'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('server-config', msg, fields)
}

/**
 * One `server.json.git.credentials[]` entry (FR-04's `admin` source, highest
 * resolver precedence -- see `git/identity/sources/admin-refs.ts`), with
 * `privateKey`/`token` already resolved past any `secretstore:` reference.
 * An operator manages these directly in `server.json`; there is no action
 * that mutates this list.
 */
export interface ServerGitCredentialConfig {
  subject: string
  host: string
  kind: 'ssh' | 'https-token'
  privateKey?: string
  publicKey?: string
  token?: string
  username?: string
}

/** `server.json.git.exchange.ado` -- Azure DevOps on-behalf-of, using the caller's own Entra access token (no separate authorize/callback step). See `git/identity/sources/exchange-ado.ts`. */
export interface ServerGitExchangeAdoConfig {
  enabled: boolean
}

/** `server.json.git.exchange.gitlab` -- a confidential OAuth application registered on the GitLab instance. See `git/identity/sources/exchange-gitlab.ts`. */
export interface ServerGitExchangeGitlabConfig {
  baseUrl: string
  clientId: string
  clientSecret: string
}

/** `server.json.git.exchange.github` -- a GitHub App's user-to-server OAuth flow. See `git/identity/sources/exchange-github.ts`. */
export interface ServerGitExchangeGithubConfig {
  clientId: string
  clientSecret: string
}

/**
 * One `server.json.git.hosts[]` entry: a self-managed git host this server
 * can create repositories on (GitHub Enterprise Server, a GitLab instance).
 * The well-known SaaS hosts need no entry.
 */
export interface ServerGitHostConfig {
  host: string
  provider: 'github' | 'gitlab' | 'azure-devops'
  /** The API root; defaults to the provider's usual path on `host`. */
  apiBaseUrl?: string
}

const GIT_HOST_PROVIDERS: ReadonlyArray<ServerGitHostConfig['provider']> = ['github', 'gitlab', 'azure-devops']

function parseGitHost(raw: unknown): ServerGitHostConfig | null {
  const h = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const host = typeof h.host === 'string' ? h.host.trim() : ''
  const provider = GIT_HOST_PROVIDERS.find((p) => p === h.provider)
  if (!host || !provider) {
    warn('server.json.git.hosts[] entry needs a host and a provider of github, gitlab or azure-devops; skipping')
    return null
  }
  return { host, provider, ...(typeof h.apiBaseUrl === 'string' && h.apiBaseUrl ? { apiBaseUrl: h.apiBaseUrl } : {}) }
}

export interface ServerGitConfig {
  credentials: ServerGitCredentialConfig[]
  /**
   * Whether the host user's own git access (the `~/.ssh` keys, a signed-in
   * `gh`/`glab`/`az`) is listed as a credential and its CLI token answers
   * when a person has no Ion credential for a host. On by default; off for a
   * server whose host user's sign-ins must not serve every person.
   */
  hostCredentials: boolean
  /** Self-managed git hosts this server can create repositories on. */
  hosts: ServerGitHostConfig[]
  /**
   * This server's own externally-reachable origin (e.g. `https://ion.example.com`),
   * used to build the `redirect_uri` for the GitLab/GitHub exchange sources'
   * authorize requests. `gitIdentity.authorize` (`protocol/git-identity-actions.ts`)
   * has no HTTP request to read an origin from (it runs over the Studio
   * WebSocket, not `/auth/login`'s HTTP GET) -- an operator sets this to the
   * SAME URL registered as the redirect URI on the GitLab/GitHub app, per
   * `docs/deployment/git-identity-setup.md`. Empty means GitLab/GitHub
   * authorize is refused with a clear configuration error; ADO's
   * on-behalf-of exchange needs no redirect URI and is unaffected.
   */
  publicOrigin: string
  exchange: {
    ado: ServerGitExchangeAdoConfig
    gitlab: ServerGitExchangeGitlabConfig | null
    github: ServerGitExchangeGithubConfig | null
  }
}

export function parseGitCredential(raw: unknown, dir: string): ServerGitCredentialConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const subject = typeof c.subject === 'string' ? c.subject : ''
  const host = typeof c.host === 'string' ? c.host : ''
  const kind = c.kind === 'ssh' || c.kind === 'https-token' ? c.kind : null
  if (!subject || !host || !kind) {
    warn('server.json.git.credentials[] entry missing subject/host/kind; skipping')
    return null
  }
  const rawKeyRef = typeof c.keyRef === 'string' ? c.keyRef : ''
  const rawTokenRef = typeof c.tokenRef === 'string' ? c.tokenRef : ''
  return {
    subject,
    host,
    kind,
    privateKey: rawKeyRef ? resolveSecretRef(rawKeyRef, dir) : undefined,
    publicKey: typeof c.publicKey === 'string' ? c.publicKey : undefined,
    token: rawTokenRef ? resolveSecretRef(rawTokenRef, dir) : undefined,
    username: typeof c.username === 'string' ? c.username : undefined,
  }
}

export function parseGit(raw: unknown, dir: string, defaults: ServerGitConfig): ServerGitConfig {
  if (!raw || typeof raw !== 'object') return defaults
  const g = raw as Record<string, unknown>
  const credentials = Array.isArray(g.credentials)
    ? g.credentials.map((c) => parseGitCredential(c, dir)).filter((c): c is ServerGitCredentialConfig => c !== null)
    : defaults.credentials

  const exchangeRaw = g.exchange && typeof g.exchange === 'object' ? (g.exchange as Record<string, unknown>) : {}

  const adoRaw = exchangeRaw.ado && typeof exchangeRaw.ado === 'object' ? (exchangeRaw.ado as Record<string, unknown>) : {}
  const ado: ServerGitExchangeAdoConfig = { enabled: typeof adoRaw.enabled === 'boolean' ? adoRaw.enabled : defaults.exchange.ado.enabled }

  let gitlab: ServerGitExchangeGitlabConfig | null = defaults.exchange.gitlab
  if (exchangeRaw.gitlab && typeof exchangeRaw.gitlab === 'object') {
    const gl = exchangeRaw.gitlab as Record<string, unknown>
    const baseUrl = typeof gl.baseUrl === 'string' ? gl.baseUrl : ''
    const clientId = typeof gl.clientId === 'string' ? gl.clientId : ''
    const rawSecret = typeof gl.clientSecretRef === 'string' ? gl.clientSecretRef : ''
    if (baseUrl && clientId && rawSecret) {
      gitlab = { baseUrl, clientId, clientSecret: resolveSecretRef(rawSecret, dir) }
    } else {
      warn('server.json.git.exchange.gitlab is missing baseUrl/clientId/clientSecretRef; treating as absent')
      gitlab = null
    }
  }

  let github: ServerGitExchangeGithubConfig | null = defaults.exchange.github
  if (exchangeRaw.github && typeof exchangeRaw.github === 'object') {
    const gh = exchangeRaw.github as Record<string, unknown>
    const clientId = typeof gh.clientId === 'string' ? gh.clientId : ''
    const rawSecret = typeof gh.clientSecretRef === 'string' ? gh.clientSecretRef : ''
    if (clientId && rawSecret) {
      github = { clientId, clientSecret: resolveSecretRef(rawSecret, dir) }
    } else {
      warn('server.json.git.exchange.github is missing clientId/clientSecretRef; treating as absent')
      github = null
    }
  }

  const publicOrigin = typeof g.publicOrigin === 'string' ? g.publicOrigin.replace(/\/+$/, '') : defaults.publicOrigin
  const hostCredentials = typeof g.hostCredentials === 'boolean' ? g.hostCredentials : defaults.hostCredentials
  const hosts = Array.isArray(g.hosts) ? g.hosts.map(parseGitHost).filter((h): h is ServerGitHostConfig => h !== null) : defaults.hosts
  return { credentials, hostCredentials, hosts, publicOrigin, exchange: { ado, gitlab, github } }
}
