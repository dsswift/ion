/**
 * principal-registry — subject -> `StudioPrincipalSummary`, populated as
 * each principal authenticates and persisted so a restart can attribute a
 * restored tab's engine session before its owner reconnects.
 *
 * `engine-bridge-start-session.ts` resolves a tab's principal for
 * `start_session` from `tab.principalSubject` (persisted at tab creation,
 * P0) through this registry, NOT through the live connection: a tab can be
 * resumed by the server (a scheduled prompt, a dispatch child) with no
 * connection attached at all, and the engine still needs to know who owns
 * the conversation it is about to write to.
 *
 * Claims are deliberately excluded from the on-disk file (never persisted,
 * matching `AuthResult.claims`'s "never sent to a client" rule extended to
 * "never written to disk either") -- only the in-memory map carries them,
 * so a restart loses claim-based tool-policy matching (FR-03) for a tab
 * until its owner reconnects, which is the same "unattributed until
 * reconnect" window every other principal-derived feature already accepts.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import { dataDir } from '../paths'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('principal-registry', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('principal-registry', msg, fields)
}

interface RegistryEntry {
  principal: StudioPrincipalSummary
  claims?: Record<string, unknown>
}

const bySubject = new Map<string, RegistryEntry>()
let loaded = false

function registryFilePath(): string {
  return join(dataDir(), 'principals.json')
}

/** Loads `principals.json` into the in-memory map once, tolerating a missing or corrupt file. */
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const path = registryFilePath()
  if (!existsSync(path)) return
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { principals?: StudioPrincipalSummary[] }
    for (const principal of parsed.principals ?? []) {
      if (principal?.subject) bySubject.set(principal.subject, { principal })
    }
    log('principal registry loaded from disk', { count: bySubject.size })
  } catch (err) {
    warn('principal registry file corrupt; starting empty', { path, error: String(err) })
  }
}

function persist(): void {
  const path = registryFilePath()
  const principals = [...bySubject.values()].map((e) => e.principal)
  try {
    atomicWriteFileSync(path, JSON.stringify({ principals }, null, 2), 0o600)
  } catch (err) {
    warn('principal registry persist failed', { path, error: String(err) })
  }
}

/** Records `principal` (and, in memory only, `claims`) as authenticated. Called once per successful `studio_hello`. */
export function registerPrincipal(principal: StudioPrincipalSummary, claims?: Record<string, unknown>): void {
  ensureLoaded()
  bySubject.set(principal.subject, { principal, claims })
  persist()
}

/** The registered principal for `subject`, or `undefined` if it has never authenticated against this server. */
export function lookupPrincipal(subject: string): StudioPrincipalSummary | undefined {
  ensureLoaded()
  return bySubject.get(subject)?.principal
}

/** Every registered principal. */
export function listPrincipals(): StudioPrincipalSummary[] {
  ensureLoaded()
  return [...bySubject.values()].map((e) => e.principal)
}

/** In-memory-only claims for `subject` (empty across a restart until the subject reconnects). */
export function lookupClaims(subject: string): Record<string, unknown> | undefined {
  ensureLoaded()
  return bySubject.get(subject)?.claims
}

/**
 * Drops every registered principal whose subject `matches` accepts and
 * registers `principal` in their place. Returns the subjects dropped. Used
 * by the host-identity migration so a restored tab's engine session resolves
 * to the host identity rather than a device that no longer acts as itself.
 */
export function rebindPrincipals(matches: (subject: string) => boolean, principal: StudioPrincipalSummary): string[] {
  ensureLoaded()
  const dropped: string[] = []
  for (const subject of [...bySubject.keys()]) {
    if (subject !== principal.subject && matches(subject)) {
      bySubject.delete(subject)
      dropped.push(subject)
    }
  }
  if (dropped.length === 0 && bySubject.has(principal.subject)) {
    log('no principals to rebind', { subject: principal.subject })
    return dropped
  }
  bySubject.set(principal.subject, { principal, claims: bySubject.get(principal.subject)?.claims })
  persist()
  log('principals rebound', { subject: principal.subject, dropped })
  return dropped
}

/** TEST ONLY. Resets the registry to empty and forces the next lookup to re-read disk. */
export function _resetPrincipalRegistryForTest(): void {
  bySubject.clear()
  loaded = false
}
