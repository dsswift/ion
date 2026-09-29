/**
 * FR-05's unified per-principal credential source (child 09): one
 * registrable interface serving BOTH credential axes -- a model provider
 * credential (subject, provider) and a git credential (subject, host) --
 * mirroring the engine-side auth.PrincipalCredentialSource seam (child 02)
 * so the two halves of this program (git identity, FR-04; provider
 * credentials, FR-05) share one resolution shape rather than drifting into
 * two.
 *
 * Sources are consulted in array order and awaited sequentially (not
 * raced), exactly like FR-04's existing git/identity/resolver.ts: a slower
 * higher-precedence source (a live token refresh) must never be shadowed by
 * a faster lower-precedence one answering first.
 */
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('principal-source', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('principal-source', msg, fields) }

/** Which credential axis a scope is asking about -- mirrors auth.CredentialScope's Provider/Host split on the engine side. */
export type CredentialAxis = { kind: 'provider'; provider: string } | { kind: 'git'; host: string }

/** What a PrincipalCredentialSource is being asked to resolve. */
export interface PrincipalCredentialScope {
  subject: string
  axis: CredentialAxis
}

/** A resolved provider credential: a bearer token/API key plus the header style to send it under (mirrors auth.RequestAuthenticator's header styles on the engine side). */
export interface ResolvedProviderCredential {
  kind: 'provider'
  token: string
  header?: string
}

/** A resolved git credential -- the existing FR-04 shape, unchanged. */
export interface ResolvedGitCredentialValue {
  kind: 'git'
  cred: import('../git/identity/types').ResolvedGitCredential
}

/** One source's answer for one scope, discriminated by axis so a provider credential and a git credential stay distinguishable at the type level. */
export interface ResolvedPrincipalCredential {
  source: string
  value: ResolvedProviderCredential | ResolvedGitCredentialValue
}

/** A source the unified resolver consults, in precedence order. */
export interface PrincipalCredentialSource {
  name: string
  resolve(
    scope: PrincipalCredentialScope,
  ): Promise<ResolvedPrincipalCredential | null> | ResolvedPrincipalCredential | null
}

const sources: PrincipalCredentialSource[] = []

/**
 * Registers a source, or replaces one already registered under the same
 * name in place -- idempotent by name, preserving precedence position,
 * matching auth.RegisterPrincipalSource's discipline on the engine side.
 */
export function registerPrincipalSource(source: PrincipalCredentialSource): void {
  const idx = sources.findIndex((s) => s.name === source.name)
  if (idx >= 0) {
    sources[idx] = source
    log('principal credential source replaced', { source: source.name })
    return
  }
  sources.push(source)
  log('principal credential source registered', { source: source.name, position: sources.length - 1 })
}

/** TEST ONLY. Clears the registry. Real process lifetime never needs to remove a source, only replace it. */
export function _unregisterAllPrincipalSourcesForTest(): void {
  sources.length = 0
}

/**
 * Walks a list of named sources sequentially (never raced), returning the
 * first non-null answer. A source that throws is caught, logged, and the
 * chain continues to the next source -- one bad source must never abort
 * resolution for a later source that might still answer, and must never
 * authenticate a run by accident on a half-failed result.
 *
 * This is the ONE sequential-resolution algorithm the program uses (R-44):
 * resolvePrincipalCredential below calls it against the global registry for
 * BOTH axes, and git/identity/resolver.ts calls it against its own local
 * exchange-source list for the git axis specifically -- one shared walk,
 * two source lists, never two competing implementations of "try each source
 * in order and log the outcome."
 */
export async function resolveFromSourceList<TSource extends { name: string }, TResult>(
  sourceList: readonly TSource[],
  resolveOne: (source: TSource) => Promise<TResult | null> | TResult | null,
  logFields: Record<string, unknown>,
): Promise<{ source: string; result: TResult } | null> {
  for (const source of sourceList) {
    let result: TResult | null
    try {
      result = await resolveOne(source)
    } catch (err) {
      warn('credential source failed', { ...logFields, source: source.name, error: String(err) })
      continue
    }
    if (result) {
      log('credential resolved', { ...logFields, source: source.name })
      return { source: source.name, result }
    }
  }
  log('no credential resolved', logFields)
  return null
}

/**
 * Resolves the credential for one scope by precedence, or null when no
 * source has one. Consults the global registry via resolveFromSourceList.
 */
export async function resolvePrincipalCredential(
  scope: PrincipalCredentialScope,
): Promise<ResolvedPrincipalCredential | null> {
  const found = await resolveFromSourceList(
    sources,
    (source) => source.resolve(scope),
    { subject: scope.subject, axis: scope.axis.kind },
  )
  return found?.result ?? null
}
