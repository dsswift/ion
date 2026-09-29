/**
 * `server.json` loader (manifest C5): the server's own configuration, distinct
 * from the durable state files (`tabs.json`, etc.) `persistence/state-files.ts`
 * gates. Every field is optional in the file on disk -- an absent file, or an
 * absent field within a present file, resolves to the documented default so a
 * bare `make bootstrap` clone boots with no `server.json` at all.
 *
 * `main.ts` carried a narrow ad-hoc subset of this schema (`listen`, `engine`)
 * before this module existed; this is now the single loader every field goes
 * through, including the auth-related ones child 08 adds (`oidc`, `relays`,
 * `pairing`, `policy`). See `docs/configuration/server-json.md` for the field
 * reference.
 */
import { existsSync, readFileSync } from 'fs'
import { installProfile } from './install-profile'
import { parseTenancy, type ServerTenancyConfig } from './tenancy-config'
import { defaultDiscoveryConfig, parseDiscovery, type ServerDiscoveryConfig } from './discovery-config'
import { hostname } from 'os'
import { directAddresses } from '../discovery/direct-addresses'
import { join } from 'path'
import type { Scope } from '@ion/shared/studio-wire/types'
import { SCOPES } from '@ion/shared/studio-wire/types'
import { log as _log, warn as _warn } from '../logger'
import type { LogLevel } from '../logger'
import { resolveSecretRef } from './secret-ref'
import { parseGit, type ServerGitConfig } from './git-config'
import { defaultLoggingConfig, parseLogging, type ServerLoggingConfig } from './logging-config'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('server-config', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('server-config', msg, fields)
}

/** `server.json.oidc` (manifest C5) -- absent means bearer is never a usable door. */
export interface ServerOidcConfig {
  issuer: string
  audience: string
  scope: string
  /**
   * The org client (SPA) registration id a browser's `oidc-client-ts`
   * `UserManager` signs in as (spec 18, additive to manifest C5/C6). Distinct
   * from `audience`, which is the SERVER's own app registration the
   * resulting access token is scoped to -- a browser authenticates AS this
   * client and requests a token FOR that audience. Empty when the operator
   * has not registered a browser sign-in client; `/auth/config` then reports
   * `clientId: ''` and the web entry shows "no browser sign-in" (spec 18
   * edge case) rather than attempting a sign-in with an empty client id.
   */
  clientId: string
  /** App-role name -> the scopes that role grants. A role absent here (or an empty array) grants nothing from that role. */
  rolesToScopes: Record<string, Scope[]>
  /** Scopes granted when the token's `roles` claim maps to none of `rolesToScopes`' keys. */
  defaultScopes: Scope[]
  /** Non-empty: `sub` must be one of these. Empty (default): every subject the issuer vouches for is allowed. */
  allowedSubjects: string[]
  /**
   * The server's own confidential-client secret, resolved past any
   * `secretstore:` reference. Empty when unset (the common case -- bearer
   * verification and the browser PKCE flow need no client secret at all).
   * FR-04's Azure DevOps on-behalf-of exchange (`git/identity/sources/exchange-ado.ts`)
   * is the one consumer: OBO requires the confidential-client assertion a
   * public SPA registration cannot provide.
   */
  clientSecret: string
}

/** One `server.json.relays[]` entry, with `psk` already resolved past any `secretstore:` reference. */
export interface ServerRelayConfig {
  url: string
  /** The relay's pre-shared key. Empty when `oidc` is set. */
  psk: string
  /** The relay authenticates with its own OIDC issuers; this server joins with a token from the operator's identity. */
  oidc?: boolean
}

export interface ServerListenConfig {
  local: boolean
  lan: boolean
  tcp: {
    host: string
    port: number
    /**
     * Whether a `paired` client may connect over TCP WITHOUT sealing its
     * frames. Default false: the TCP listener speaks plain `ws://`, so an
     * unsealed paired session puts every event, message body, and terminal
     * byte on the LAN in cleartext. Set true only to admit a client that
     * predates sealed TCP while it is being updated.
     */
    allowUnsealedPaired: boolean
  }
}

export interface ServerPairingConfig {
  defaultScopes: Scope[]
  /**
   * The HTTP base URL a pairing link tells the joining client to dial --
   * `http://<host>:<port>` as reachable FROM the client, not from the server
   * itself. `null` (the default) derives it at mint time from this machine's
   * hostname and `listen.tcp.port` (`pairingAdvertiseUrl`). Set it
   * explicitly when the server sits behind a reverse proxy, a NAT, or a
   * hostname the LAN cannot resolve (a `.local` mDNS name is usually the
   * right value on a home network).
   */
  advertiseUrl: string | null
}

export interface ServerPolicyConfig {
  authPolicy: string
  actionInterceptor: string
  snapshotProjector: string
}


/**
 * One `server.json.providerCredentials[]` entry (FR-05 child 09's `admin`
 * source, highest resolver precedence -- see
 * `credentials/sources/admin-refs.ts`), with `value` already resolved past
 * any `secretstore:` reference. An operator manages these directly in
 * `server.json`; there is no action that mutates this list, matching
 * `git.credentials`'s existing operator-owned shape.
 */
export interface ServerProviderCredentialConfig {
  subject: string
  provider: string
  /** The resolved token/API key value. Never logged. */
  value: string
  /** Auth header style to send the value under (e.g. "x-api-key"). Empty means the provider's own default applies. */
  header?: string
}

/**
 * `server.json.homeProject` -- declarative, self-healing provisioning for a
 * personal instance's "home" project: the directory every fresh sign-in
 * lands in, backed by the owner's own ops repository, with a fixed engine
 * profile as that project's default.
 *
 * Applied idempotently at every boot (`bootstrap/home-project.ts`), not a
 * one-time migration: a personal instance's `settings.json` is a stateful
 * file on a PVC that survives redeploys, but is also the exact file every
 * client-side settings save touches. A single unrelated save with a stale
 * in-memory snapshot can silently re-freeze this project's registration
 * away (confirmed live, 2026-09-16 -- the actual incident this config
 * section exists to stop from recurring). Re-deriving the correct state
 * from this config on every boot means drift self-heals within one restart
 * instead of requiring another manual `kubectl exec` patch.
 */
export interface ServerHomeProjectConfig {
  /** Absolute, or relative to this server process's own $HOME. */
  directory: string
  /** SSH clone URL. Cloned into `directory` on first boot ONLY -- if `directory` already exists, it is never touched, cloned into, or overwritten, whether or not it looks like a git repo. */
  gitRemote: string
  /** The engine profile registered (by name, as a stable id) and set as this project's default profileOverride. */
  engineProfile: { name: string; extensions: string[]; defaultMode?: 'auto' | 'plan' }
}

export interface ServerConfig {
  label: string
  listen: ServerListenConfig
  oidc: ServerOidcConfig | null
  relays: ServerRelayConfig[]
  pairing: ServerPairingConfig
  engine: { minVersion: string }
  web: { enabled: boolean }
  policy: ServerPolicyConfig
  tenancy: ServerTenancyConfig
  /** The tenancy mode in force when `tenancy.mode` is not set: `shared` for one person's own install (`config/install-profile.ts`), else `isolated`. */
  tenancyDefault: 'shared' | 'isolated'
  discovery: ServerDiscoveryConfig
  git: ServerGitConfig
  /** `server.json.providerCredentials[]` -- FR-05 child 09's operator-managed `admin` source for model-provider credentials. Empty by default; a single-user server is unaffected. */
  providerCredentials: ServerProviderCredentialConfig[]
  logLevel: LogLevel
  /** `server.json.logging` -- whether this server ships its own log lines, and which files it carries. */
  logging: ServerLoggingConfig
  /** Absent (default) on a shared/team instance: no home project is provisioned. */
  homeProject: ServerHomeProjectConfig | null
}

/** Every `pairing.defaultScopes` entry manifest C5's example lists, minus `admin` (pairing links never default to admin -- see pairing-links.ts). */
const DEFAULT_PAIRING_SCOPES: readonly Scope[] = ['conversations:read', 'conversations:operate', 'terminal:operate', 'git:write']

function parsePairing(raw: unknown, defaults: ServerPairingConfig): ServerPairingConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const defaultScopes = Array.isArray(obj.defaultScopes)
    ? asScopeArray(obj.defaultScopes, 'pairing.defaultScopes')
    : defaults.defaultScopes
  let advertiseUrl = defaults.advertiseUrl
  if (typeof obj.advertiseUrl === 'string' && obj.advertiseUrl) {
    try {
      const parsed = new URL(obj.advertiseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`unsupported protocol ${parsed.protocol}`)
      advertiseUrl = obj.advertiseUrl.replace(/\/$/, '')
    } catch (err) {
      warn('pairing.advertiseUrl ignored: not an http(s) URL', { value: obj.advertiseUrl, error: String(err) })
    }
  } else if (obj.advertiseUrl !== undefined && obj.advertiseUrl !== null) {
    warn('pairing.advertiseUrl ignored: expected a string', { type: typeof obj.advertiseUrl })
  }
  return { defaultScopes, advertiseUrl }
}

/**
 * The HTTP base URL embedded in every pairing link this server mints: the
 * configured `pairing.advertiseUrl`, else this machine's LAN address and
 * `listen.tcp.port`. A pairing link without a dialable URL is useless to the
 * joining client -- the code alone does not say which server it belongs to.
 *
 * It is an ADDRESS and not a name on purpose. `os.hostname()` is the bare
 * name (`jolteon`), which carries no `.local` suffix, so no responder answers
 * it: `dns-sd -G v4 jolteon` returns "No Such Record" while `jolteon.local`
 * returns the address. Every link minted with the bare name pointed the
 * joining client at a host that does not exist. An address needs no resolver
 * at all, which is what a link handed to a client on this network wants.
 *
 * The machine's own `<hostname>.local` is the fallback, for a host with no
 * non-loopback address to offer: it at least resolves, because the OS answers
 * for it. Referencing that name is safe -- what must never happen is
 * PUBLISHING an A record for it, which is a second claim on a name the OS
 * already defends (see `discovery/advertiser.ts`).
 */
export function pairingAdvertiseUrl(config: Pick<ServerConfig, 'pairing' | 'listen'>): string {
  if (config.pairing.advertiseUrl) return config.pairing.advertiseUrl
  const [lan] = directAddresses(config.listen.tcp.port)
  if (lan) return lan
  const bare = hostname().replace(/\.$/, '')
  return `http://${bare.includes('.') ? bare : `${bare}.local`}:${config.listen.tcp.port}`
}

function defaultLabel(): string {
  try {
    return hostname()
  } catch (err) {
    warn('hostname() failed; falling back to a fixed label', { error: String(err) })
    return 'Ion Studio Server'
  }
}

export function defaultServerConfig(): ServerConfig {
  // One person's own install: every paired device is theirs, so it sees
  // their conversations and administers the install. Stated by the
  // launcher, never inferred; explicit server.json values still win.
  const personal = installProfile() === 'personal'
  return {
    label: defaultLabel(),
    listen: { local: true, lan: true, tcp: { host: '0.0.0.0', port: 7331, allowUnsealedPaired: false } },
    oidc: null,
    relays: [],
    pairing: { defaultScopes: personal ? [...DEFAULT_PAIRING_SCOPES, 'admin'] : [...DEFAULT_PAIRING_SCOPES], advertiseUrl: null },
    engine: { minVersion: '0.0.0' },
    web: { enabled: false },
    policy: { authPolicy: 'default', actionInterceptor: 'default', snapshotProjector: 'default' },
    // No explicit override -- unownedTabsVisible() derives the default live from oidc.
    tenancy: {},
    tenancyDefault: personal ? 'shared' : 'isolated',
    discovery: defaultDiscoveryConfig(),
    git: { credentials: [], publicOrigin: '', exchange: { ado: { enabled: false }, gitlab: null, github: null } },
    providerCredentials: [],
    logLevel: 'DEBUG',
    logging: defaultLoggingConfig(),
    homeProject: null,
  }
}

function parseHomeProject(raw: unknown): ServerHomeProjectConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Record<string, unknown>
  const directory = typeof h.directory === 'string' ? h.directory.trim() : ''
  const gitRemote = typeof h.gitRemote === 'string' ? h.gitRemote.trim() : ''
  const profileRaw = h.engineProfile && typeof h.engineProfile === 'object' ? h.engineProfile as Record<string, unknown> : null
  const name = profileRaw && typeof profileRaw.name === 'string' ? profileRaw.name.trim() : ''
  const extensions = profileRaw && Array.isArray(profileRaw.extensions)
    ? profileRaw.extensions.filter((e): e is string => typeof e === 'string')
    : []
  if (!directory || !gitRemote || !name || extensions.length === 0) {
    warn('server.json.homeProject is missing directory/gitRemote/engineProfile.name/engineProfile.extensions; treating as absent', {
      has_directory: !!directory, has_git_remote: !!gitRemote, has_profile_name: !!name, extension_count: extensions.length,
    })
    return null
  }
  const defaultMode = profileRaw?.defaultMode === 'plan' ? 'plan' as const : 'auto' as const
  return { directory, gitRemote, engineProfile: { name, extensions, defaultMode } }
}

/** The `unownedTabs` default for a given `oidc` config -- see `ServerTenancyConfig`'s docstring. Also the live fallback `config/current.ts`'s `unownedTabsVisible()` uses when no explicit override is set. */
export function unownedTabsDefault(oidc: ServerOidcConfig | null): 'visible' | 'hidden' {
  return oidc !== null ? 'hidden' : 'visible'
}


function isScope(v: unknown): v is Scope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v)
}

function asScopeArray(v: unknown, field: string): Scope[] {
  if (!Array.isArray(v)) return []
  const out: Scope[] = []
  for (const entry of v) {
    if (isScope(entry)) out.push(entry)
    else warn('server.json: dropping non-scope entry', { field, entry })
  }
  return out
}

function parseOidc(raw: unknown, dir: string): ServerOidcConfig | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') {
    warn('server.json.oidc is present but not an object; treating as absent (bearer door disabled)')
    return null
  }
  const o = raw as Record<string, unknown>
  const issuer = typeof o.issuer === 'string' ? o.issuer : ''
  const audience = typeof o.audience === 'string' ? o.audience : ''
  const scope = typeof o.scope === 'string' ? o.scope : ''
  if (!issuer || !audience || !scope) {
    warn('server.json.oidc is missing issuer/audience/scope; treating as absent (bearer door disabled)', { has_issuer: !!issuer, has_audience: !!audience, has_scope: !!scope })
    return null
  }
  const rolesToScopes: Record<string, Scope[]> = {}
  if (o.rolesToScopes && typeof o.rolesToScopes === 'object') {
    for (const [role, scopes] of Object.entries(o.rolesToScopes as Record<string, unknown>)) {
      rolesToScopes[role] = asScopeArray(scopes, `oidc.rolesToScopes.${role}`)
    }
  }
  return {
    issuer,
    audience,
    scope,
    // Absent means "no browser sign-in client registered" -- a valid,
    // non-error configuration (bearer auth for desktop/mobile-bridge clients
    // still works with no clientId at all). See ServerOidcConfig's docstring.
    clientId: typeof o.clientId === 'string' ? o.clientId : '',
    rolesToScopes,
    defaultScopes: asScopeArray(o.defaultScopes, 'oidc.defaultScopes'),
    allowedSubjects: Array.isArray(o.allowedSubjects) ? o.allowedSubjects.filter((s): s is string => typeof s === 'string') : [],
    clientSecret: typeof o.clientSecretRef === 'string' && o.clientSecretRef ? resolveSecretRef(o.clientSecretRef, dir) : '',
  }
}


function parseProviderCredential(raw: unknown, dir: string): ServerProviderCredentialConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const subject = typeof c.subject === 'string' ? c.subject : ''
  const provider = typeof c.provider === 'string' ? c.provider : ''
  const rawValueRef = typeof c.value === 'string' ? c.value : ''
  if (!subject || !provider || !rawValueRef) {
    warn('server.json.providerCredentials[] entry missing subject/provider/value; skipping')
    return null
  }
  const value = resolveSecretRef(rawValueRef, dir)
  if (!value) {
    warn('server.json.providerCredentials[] entry value did not resolve; skipping', { subject, provider })
    return null
  }
  return {
    subject,
    provider,
    value,
    header: typeof c.header === 'string' ? c.header : undefined,
  }
}

function parseProviderCredentials(raw: unknown, dir: string): ServerProviderCredentialConfig[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((c) => parseProviderCredential(c, dir))
    .filter((c): c is ServerProviderCredentialConfig => c !== null)
}

function parseRelays(raw: unknown, dir: string): ServerRelayConfig[] {
  if (!Array.isArray(raw)) return []
  const out: ServerRelayConfig[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const url = typeof e.url === 'string' ? e.url : ''
    if (!url) {
      warn('server.json.relays[] entry missing url; skipping')
      continue
    }
    const rawPsk = typeof e.psk === 'string' ? e.psk : ''
    const oidc = e.auth === 'oidc'
    out.push({ url, psk: rawPsk ? resolveSecretRef(rawPsk, dir) : '', ...(oidc ? { oidc: true } : {}) })
  }
  return out
}

function parseListen(raw: unknown, defaults: ServerListenConfig): ServerListenConfig {
  if (!raw || typeof raw !== 'object') return defaults
  const l = raw as Record<string, unknown>
  const tcpRaw = l.tcp && typeof l.tcp === 'object' ? (l.tcp as Record<string, unknown>) : {}
  return {
    local: typeof l.local === 'boolean' ? l.local : defaults.local,
    lan: typeof l.lan === 'boolean' ? l.lan : defaults.lan,
    tcp: {
      host: typeof tcpRaw.host === 'string' ? tcpRaw.host : defaults.tcp.host,
      port: typeof tcpRaw.port === 'number' ? tcpRaw.port : defaults.tcp.port,
      allowUnsealedPaired: typeof tcpRaw.allowUnsealedPaired === 'boolean' ? tcpRaw.allowUnsealedPaired : defaults.tcp.allowUnsealedPaired,
    },
  }
}

function parsePolicy(raw: unknown, defaults: ServerPolicyConfig): ServerPolicyConfig {
  if (!raw || typeof raw !== 'object') return defaults
  const p = raw as Record<string, unknown>
  return {
    authPolicy: typeof p.authPolicy === 'string' ? p.authPolicy : defaults.authPolicy,
    actionInterceptor: typeof p.actionInterceptor === 'string' ? p.actionInterceptor : defaults.actionInterceptor,
    snapshotProjector: typeof p.snapshotProjector === 'string' ? p.snapshotProjector : defaults.snapshotProjector,
  }
}

const LOG_LEVELS: readonly LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']

/**
 * An unrecognised level used to fall back silently, so a typo ("debug",
 * "verbose") left the server logging at a level nobody chose with nothing
 * said about it -- and the absence of the expected lines then reads as "that
 * code path never ran".
 */
function parseLogLevel(raw: unknown, fallback: LogLevel): LogLevel {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'string' && (LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel
  warn('server.json.logLevel is not a known level; using the default', { value: raw, known: LOG_LEVELS, using: fallback })
  return fallback
}

/**
 * Loads and validates `<dir>/server.json`. Never throws: a missing file
 * returns every default (logged at INFO, matching main.ts's prior
 * `server.json absent; using defaults` behavior); a present-but-corrupt or
 * partially-malformed file falls back field-by-field, logging each dropped
 * field at WARN -- `server.json` configures the server, not its durable
 * conversation/tab state, so it is never gated behind `StateFileCorrupt` the
 * way `persistence/state-files.ts` gates `tabs.json`.
 */
export function loadServerConfig(dir: string): ServerConfig {
  const defaults = defaultServerConfig()
  const path = join(dir, 'server.json')
  if (!existsSync(path)) {
    log('server.json absent; using defaults')
    return defaults
  }

  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('server.json root is not an object')
    raw = parsed as Record<string, unknown>
  } catch (err) {
    warn('server.json unreadable or malformed; using defaults', { error: String(err) })
    return defaults
  }

  const oidc = parseOidc(raw.oidc, dir)
  const config: ServerConfig = {
    label: typeof raw.label === 'string' && raw.label ? raw.label : defaults.label,
    listen: parseListen(raw.listen, defaults.listen),
    oidc,
    relays: parseRelays(raw.relays, dir),
    pairing: parsePairing(raw.pairing, defaults.pairing),
    engine: {
      minVersion: raw.engine && typeof raw.engine === 'object' && typeof (raw.engine as Record<string, unknown>).minVersion === 'string'
        ? (raw.engine as Record<string, unknown>).minVersion as string
        : defaults.engine.minVersion,
    },
    web: {
      enabled: raw.web && typeof raw.web === 'object' && typeof (raw.web as Record<string, unknown>).enabled === 'boolean'
        ? (raw.web as Record<string, unknown>).enabled as boolean
        : defaults.web.enabled,
    },
    policy: parsePolicy(raw.policy, defaults.policy),
    tenancy: parseTenancy(raw.tenancy),
    tenancyDefault: defaults.tenancyDefault,
    discovery: parseDiscovery(raw.discovery),
    git: parseGit(raw.git, dir, defaults.git),
    providerCredentials: parseProviderCredentials(raw.providerCredentials, dir),
    logLevel: parseLogLevel(raw.logLevel, defaults.logLevel),
    logging: parseLogging(raw.logging),
    homeProject: parseHomeProject(raw.homeProject),
  }

  log('server.json loaded', {
    label: config.label,
    listen_local: config.listen.local,
    listen_lan: config.listen.lan,
    tcp_port: config.listen.tcp.port,
    oidc_configured: config.oidc !== null,
    relay_count: config.relays.length,
    web_enabled: config.web.enabled,
    home_project_configured: config.homeProject !== null,
    log_egress_targets: config.logging.egress?.egressTargets ?? [],
    log_ship_sources: config.logging.shipSources,
  })
  return config
}

export type { ServerTenancyConfig } from './tenancy-config'
export type {
  ServerGitConfig,
  ServerGitCredentialConfig,
  ServerGitExchangeAdoConfig,
  ServerGitExchangeGitlabConfig,
  ServerGitExchangeGithubConfig,
} from './git-config'
