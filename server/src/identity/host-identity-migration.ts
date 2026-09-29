/**
 * host-identity-migration — folds device-shaped principals (`paired:*`) into
 * the install's own identity on a shared-tenancy server.
 *
 * Before host identity existed, every pairing was its own principal, so a
 * person's git credentials and per-principal state were keyed by the device
 * (or the pairing) that stored them and did not follow the person to their
 * next laptop or their next pairing. On a shared-tenancy install every
 * paired device is the owner's, so on boot everything keyed `paired:*` is
 * moved under the host subject (`local:<username>`):
 *
 *   - `credentials.json`   -- the pairing records themselves
 *   - `git-credentials.json` -- git keys and tokens (newest per host wins)
 *   - `principals.json`    -- the principal registry
 *   - `principals/<dir>/`  -- materialised git files (merged; the target's
 *     copy wins because it is regenerated from the store anyway)
 *   - `tabs.json`, `studio-terminals.json` -- `principalSubject` stamps
 *
 * Runs on every boot, not once: it is idempotent (nothing keyed `paired:*`
 * remains after a pass) and a server flipped from isolated to shared later
 * needs the same fold. Isolated tenancy is untouched -- there a device may
 * legitimately be its own principal.
 *
 * The fold itself (`foldSubjects`) takes which subjects and which principal
 * directories move, so `subject-moves.ts` reuses it to carry one person from
 * an old sign-in subject to a new one.
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { PersistedTab, PersistedTabState } from '@ion/shared/types'
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { credentialsStore } from '../auth/credentials-store'
import { gitCredentialStore } from '../git/identity/credential-store'
import { rebindPrincipals } from './principal-registry'
import { principalDir } from '../conversation/principal-dir'
import { isDeviceSubject } from './paired-subject'
import { log as _log, error as _error } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('host-identity-migration', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('host-identity-migration', msg, fields)
}

export interface HostIdentityMigrationResult {
  pairings: string[]
  gitHosts: string[]
  principals: string[]
  principalDirs: string[]
  tabs: number
  terminals: number
}

/** What moves, and where to. */
export interface SubjectFold {
  /** True for a subject whose records move to `principal.subject`. */
  matches: (subject: string) => boolean
  /** True for a `principals/` directory name whose contents move into the target's directory. */
  movesDir: (name: string) => boolean
  /** The subject everything lands on, as the principal registry records it. */
  principal: StudioPrincipalSummary
  /** Appended to a rewritten file's path for the copy kept beside it. */
  backupSuffix: string
}

interface PersistedStudioTerminalsFile {
  version: 1
  terminals: Array<{ key: string; principalSubject?: string }>
}

/** Rewrites matching `principalSubject` stamps in place. Returns the count rewritten. */
function restamp<T extends { principalSubject?: string }>(records: T[], fold: SubjectFold): number {
  let n = 0
  for (const r of records) {
    if (r.principalSubject && r.principalSubject !== fold.principal.subject && fold.matches(r.principalSubject)) {
      r.principalSubject = fold.principal.subject
      n++
    }
  }
  return n
}

/** Backs `path` up beside itself, then writes `contents`. */
function backupAndWrite(path: string, contents: string, fold: SubjectFold): void {
  copyFileSync(path, `${path}${fold.backupSuffix}`)
  atomicWriteFileSync(path, contents, 0o600)
}

function migrateTabs(dir: string, fold: SubjectFold): number {
  const path = join(dir, 'tabs.json')
  if (!existsSync(path)) return 0
  let state: PersistedTabState
  try {
    state = JSON.parse(readFileSync(path, 'utf-8')) as PersistedTabState
  } catch (err) {
    error('tabs.json unreadable; not migrated', { path, error: String(err) })
    return 0
  }
  const tabs: PersistedTab[] = Array.isArray(state.tabs) ? state.tabs : []
  const settled: PersistedTab[] = Array.isArray(state.settledHistory) ? state.settledHistory : []
  const n = restamp(tabs, fold) + restamp(settled, fold)
  if (n > 0) backupAndWrite(path, JSON.stringify(state, null, 2), fold)
  log('tabs.json migrated', { restamped: n, total: tabs.length + settled.length })
  return n
}

function migrateTerminals(dir: string, fold: SubjectFold): number {
  const path = join(dir, 'studio-terminals.json')
  if (!existsSync(path)) return 0
  let file: PersistedStudioTerminalsFile
  try {
    file = JSON.parse(readFileSync(path, 'utf-8')) as PersistedStudioTerminalsFile
  } catch (err) {
    error('studio-terminals.json unreadable; not migrated', { path, error: String(err) })
    return 0
  }
  const terminals = Array.isArray(file.terminals) ? file.terminals : []
  const n = restamp(terminals, fold)
  if (n > 0) backupAndWrite(path, JSON.stringify(file), fold)
  log('studio-terminals.json migrated', { restamped: n, total: terminals.length })
  return n
}

/**
 * Merges every matching `principals/` directory into the target principal's
 * directory: an entry the target lacks is moved across, one it already has
 * is dropped (materialised git files are regenerated from the store on the
 * next use). The emptied source directory is removed.
 */
function mergePrincipalDirs(dir: string, fold: SubjectFold): string[] {
  const root = join(dir, 'principals')
  if (!existsSync(root)) return []
  const subject = fold.principal.subject
  const target = join(root, principalDir(subject))
  const merged: string[] = []
  for (const name of readdirSync(root)) {
    if (!fold.movesDir(name) || name === principalDir(subject)) continue
    const source = join(root, name)
    try {
      mergeInto(source, target)
      rmSync(source, { recursive: true, force: true })
      merged.push(name)
      log('principal directory merged', { from: name, to: principalDir(subject) })
    } catch (err) {
      error('principal directory merge failed; left in place', { from: name, error: String(err) })
    }
  }
  return merged
}

function mergeInto(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (!existsSync(to)) {
      renameSync(from, to)
    } else if (entry.isDirectory()) {
      mergeInto(from, to)
    }
    // A file the target already has stays the target's.
  }
}

/** Moves every record `fold` matches onto `fold.principal.subject`. Idempotent: a second pass finds nothing to move. */
export function foldSubjects(dir: string, fold: SubjectFold): HostIdentityMigrationResult {
  const subject = fold.principal.subject
  const pairings = credentialsStore().rebindSubjects(fold.matches, subject)
  const gitHosts = gitCredentialStore().rebindSubjects(fold.matches, subject)
  const principals = rebindPrincipals(fold.matches, fold.principal)
  const principalDirs = mergePrincipalDirs(dir, fold)
  const tabs = migrateTabs(dir, fold)
  const terminals = migrateTerminals(dir, fold)
  return { pairings, gitHosts, principals, principalDirs, tabs, terminals }
}

/** Runs the fold described in the module comment against `dir`. */
export function migrateToHostIdentity(dir: string, subject: string): HostIdentityMigrationResult {
  log('folding device-shaped principals into the host identity', { data_dir: dir, subject })
  const result = foldSubjects(dir, {
    matches: isDeviceSubject,
    movesDir: (name) => name.startsWith('paired-'),
    principal: { subject, displayName: subject.replace(/^local:/, '') },
    backupSuffix: '.pre-host-identity.bak',
  })
  log('host identity migration complete', { subject, pairings: result.pairings.length, git_hosts: result.gitHosts, principals: result.principals, principal_dirs: result.principalDirs, tabs: result.tabs, terminals: result.terminals })
  return result
}
