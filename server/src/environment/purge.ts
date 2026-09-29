/**
 * environment/purge — the reverse of the SSH door: appraise what Ion has
 * left on THIS host, then remove exactly the degree the operator ticked.
 *
 * Four levels, additive:
 *   - `studio` (always): the services and the bundle, via the bundle's own
 *     `ion studio uninstall`, scheduled detached because that command stops
 *     the server running this code.
 *   - `gitCredentials`: the principal's stored git keys and tokens.
 *   - `clones`: every project Ion cloned here (`clonedByIon`), refused per
 *     clone while dirty unless forced. A folder the operator pointed Ion at
 *     is never touched.
 *   - `data`: the whole data dir (conversations, engine.json, server.json,
 *     credentials), passed to uninstall as `--purge-data`.
 *
 * Clones and credentials are removed first, while the server is alive to
 * report on them; the uninstall is scheduled last and the reply carries
 * what was done before the process goes away.
 */
import { spawn } from 'child_process'
import { existsSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import type { EnvironmentPurgeAppraisal, EnvironmentPurgeLevels, EnvironmentPurgeResult } from '@ion/shared/types-environment-admin'
import { dataDir } from '../paths'
import { resolveConversationsDirSync } from '../conversation/principal-paths'
import { gitCredentialStore } from '../git/identity/credential-store'
import { readProjectRegistry, appraiseRemoval, removeProject } from './projects'
import { studioBundleRoot, readBundleVersion } from './host-info'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.purge'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Recursive byte count, tolerant of unreadable entries (they count as zero and are logged once per call). */
export function directoryBytes(path: string): number {
  let total = 0
  let unreadable = 0
  const walk = (p: string): void => {
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(p, { withFileTypes: true }) } catch { unreadable++; return } // silent-ok: counted and logged below
    for (const e of entries) {
      const full = join(p, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(full)
      else {
        try { total += statSync(full).size } catch { unreadable++ } // silent-ok: counted and logged below
      }
    }
  }
  if (existsSync(path)) walk(path)
  if (unreadable > 0) log('directory size skipped unreadable entries', { path, unreadable })
  return total
}

function countConversations(subject: string | undefined): number {
  const dir = resolveConversationsDirSync(subject)
  if (!existsSync(dir)) return 0
  const ids = new Set<string>()
  for (const name of readdirSync(dir)) {
    const m = /^(.+?)\.(tree|llm)\.jsonl$/.exec(name) ?? /^(.+?)\.jsonl$/.exec(name)
    if (m) ids.add(m[1])
  }
  return ids.size
}

export async function appraisePurge(subject: string | undefined): Promise<EnvironmentPurgeAppraisal> {
  const registry = readProjectRegistry()
  const clonedProjects: EnvironmentPurgeAppraisal['clonedProjects'] = []
  for (const [dir, entry] of Object.entries(registry)) {
    if (!entry.clonedByIon) continue
    const a = await appraiseRemoval(dir)
    clonedProjects.push({ dir, dirty: a.dirty, bytes: a.exists ? directoryBytes(dir) : 0 })
  }
  const root = studioBundleRoot()
  const version = root ? readBundleVersion(root) : null
  const appraisal: EnvironmentPurgeAppraisal = {
    conversations: countConversations(subject),
    dataBytes: directoryBytes(dataDir()),
    clonedProjects,
    gitCredentialHosts: subject ? gitCredentialStore().listFor(subject).map((c) => c.host) : [],
    bundle: root && version ? { root, version: version.server } : null,
  }
  log('purge appraised', { conversations: appraisal.conversations, data_bytes: appraisal.dataBytes, clones: clonedProjects.length, dirty_clones: clonedProjects.filter((c) => c.dirty).length, credential_hosts: appraisal.gitCredentialHosts.length, has_bundle: !!appraisal.bundle })
  return appraisal
}

/** Spawns the bundle's `ion studio uninstall` detached so it outlives this server. Returns the failure reason when it cannot be started. */
export function scheduleUninstall(root: string, purgeData: boolean, spawnImpl: typeof spawn = spawn): string | null {
  const bin = join(root, 'current', 'bin', 'ion')
  if (!existsSync(bin)) return `${bin} is missing; the bundle is incomplete`
  const args = ['studio', 'uninstall', '--yes', ...(purgeData ? ['--purge-data'] : [])]
  try {
    const child = spawnImpl(bin, args, { detached: true, stdio: 'ignore', env: { ...process.env, ION_DATA_DIR: dataDir() } })
    child.unref()
    log('uninstall scheduled', { bin, purge_data: purgeData, pid: child.pid ?? 0 })
    return null
  } catch (err) {
    warn('uninstall could not be scheduled', { bin, error: String(err) })
    return String(err)
  }
}

export async function runPurge(levels: EnvironmentPurgeLevels, subject: string | undefined, spawnImpl?: typeof spawn): Promise<EnvironmentPurgeResult> {
  log('purge requested', { levels: { ...levels } })
  const result: EnvironmentPurgeResult = { removedClones: [], keptDirtyClones: [], removedGitCredentialHosts: [], uninstallScheduled: false }
  if (levels.clones) {
    for (const [dir, entry] of Object.entries(readProjectRegistry())) {
      if (!entry.clonedByIon) continue
      try {
        const out = await removeProject(dir, { deleteFiles: true, force: levels.force === true })
        if (out.deletedFiles) result.removedClones.push(dir)
      } catch (err) {
        warn('clone kept during purge', { dir, error: String(err) })
        result.keptDirtyClones.push(dir)
      }
    }
  }
  if (levels.gitCredentials && subject) {
    const store = gitCredentialStore()
    for (const cred of store.listFor(subject)) {
      if (store.remove(subject, cred.host)) result.removedGitCredentialHosts.push(cred.host)
    }
    log('git credentials removed', { subject, hosts: result.removedGitCredentialHosts })
  }
  if (levels.data) {
    // Everything under the data dir goes with the uninstall; what is not
    // covered by it (the desktop's materialised keys live inside it too) is
    // deleted here first so a failed uninstall still leaves no secrets.
    const materialized = join(dataDir(), 'principals')
    if (existsSync(materialized)) {
      rmSync(materialized, { recursive: true, force: true })
      log('materialised principal state removed', { path: materialized })
    }
  }
  const root = studioBundleRoot()
  if (!root) {
    result.uninstallError = 'this server was not installed from a Studio Server bundle, so there are no services to remove here'
    warn('purge: no bundle to uninstall', {})
    return result
  }
  const err = scheduleUninstall(root, levels.data, spawnImpl)
  if (err) result.uninstallError = err
  else result.uninstallScheduled = true
  log('purge finished', { removed_clones: result.removedClones.length, kept: result.keptDirtyClones.length, credentials: result.removedGitCredentialHosts.length, uninstall_scheduled: result.uninstallScheduled })
  return result
}
