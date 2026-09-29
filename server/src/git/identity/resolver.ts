/**
 * FR-04's credential precedence resolver: admin > exchange > user. The first
 * source in {@link defaultSources} to answer non-null for a `(subject, host)`
 * pair wins -- an operator-managed `admin` ref always overrides an
 * OAuth-exchanged or self-supplied credential for the same pair, and an
 * exchange always overrides a user-supplied one, matching the plan's stated
 * precedence.
 *
 * FR-05 child 09 (R-44): this resolver no longer re-derives its own
 * sequential-walk-catch-log algorithm. It calls
 * credentials/principal-source.ts's resolveFromSourceList -- the SAME
 * function the unified provider-credential resolver
 * (resolvePrincipalCredential) calls -- against its own local `sources`
 * list. The `admin` entry is the literal same adminRefsSource
 * implementation the unified resolver uses (credentials/sources/admin-refs.ts),
 * so there is exactly one `admin` implementation covering both axes, not
 * two independently-maintained ones that could drift. What stays local to
 * this module is the GIT-SPECIFIC exchange/user-supplied source list and
 * its test bookkeeping (registerExchangeSource, _resetResolverSourcesForTest)
 * -- registering a git exchange source has no bearing on the model-provider
 * axis, so keeping it off the global cross-axis registry is what keeps a
 * test in THIS file from ever needing to know about provider-credential
 * sources or vice versa.
 */
import type { GitCredentialSourceProvider, ResolvedGitCredential } from './types'
import { adminRefsSource } from '../../credentials/sources/admin-refs'
import { resolveFromSourceList } from '../../credentials/principal-source'
import { userSuppliedSource } from './sources/user-supplied'
import { adoExchangeSource } from './sources/exchange-ado'
import { gitlabExchangeSource } from './sources/exchange-gitlab'
import { githubExchangeSource } from './sources/exchange-github'
import { currentServerConfig } from '../../config/current'

function defaultSources(): GitCredentialSourceProvider[] {
  return [
    adminRefsSourceAsGit(),
    adoExchangeSource(() => currentServerConfig().oidc, () => currentServerConfig().git.exchange.ado.enabled),
    gitlabExchangeSource(() => currentServerConfig().git.exchange.gitlab),
    githubExchangeSource(() => currentServerConfig().git.exchange.github),
  ]
}

/**
 * Adapts the unified `admin` source (which resolves BOTH axes) to this
 * module's git-only GitCredentialSourceProvider shape, so resolver.ts keeps
 * calling it as `(subject, host) => GitCredentialLookup` exactly as it did
 * before this program, while the underlying implementation is the single
 * shared one.
 */
function adminRefsSourceAsGit(): GitCredentialSourceProvider {
  const unified = adminRefsSource(
    () => currentServerConfig().providerCredentials,
    () => currentServerConfig().git.credentials,
  )
  return {
    name: 'admin',
    resolve: async (subject, host) => {
      const resolved = await unified.resolve({ subject, axis: { kind: 'git', host } })
      if (!resolved || resolved.value.kind !== 'git') return null
      return resolved.value.cred
    },
  }
}

/**
 * The resolver's source list in precedence order (admin, then every
 * exchange, then -- appended lazily by `ensureUserSource` -- `user`). A
 * mutable module-level array (rather than a function computing it fresh
 * every call) so a test can register a stand-in exchange source via
 * `registerExchangeSource` without reaching into module internals.
 */
const sources: GitCredentialSourceProvider[] = defaultSources()

let userSourceInserted = false

/** Ensures the lowest-precedence `user` source is always last, added once. */
function ensureUserSource(): void {
  if (userSourceInserted) return
  sources.push(userSuppliedSource())
  userSourceInserted = true
}

/**
 * Registers an exchange source at the given precedence slot (after `admin`,
 * before `user`). Idempotent by name -- re-registering the same exchange
 * (e.g. a test resetting a source) replaces its prior instance rather than
 * duplicating it.
 */
export function registerExchangeSource(source: GitCredentialSourceProvider): void {
  const idx = sources.findIndex((s) => s.name === source.name)
  if (idx >= 0) sources[idx] = source
  else sources.push(source) // before ensureUserSource() appends 'user'
}

/** TEST ONLY. Resets the resolver's source list to the real defaults (admin + every exchange, `user` lazily). */
export function _resetResolverSourcesForTest(): void {
  sources.length = 0
  sources.push(...defaultSources())
  userSourceInserted = false
}

/** Resolves the credential for `(subject, host)` by precedence, or null when no source has one. */
export async function resolveGitCredential(subject: string, host: string): Promise<ResolvedGitCredential | null> {
  ensureUserSource()
  const found = await resolveFromSourceList(
    sources,
    (source) => source.resolve(subject, host),
    { subject, git_host: host },
  )
  return found?.result ?? null
}
