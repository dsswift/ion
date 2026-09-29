/**
 * environment/projects — the project registry of THIS Environment, as the
 * Environment page edits it: list, add, remove (optionally deleting a clone
 * Ion made), relocate, trust a project Ion cloned, and run the project's
 * own setup recipe.
 *
 * The registry is `settings.json`'s `projects` key on this server's host,
 * the same record the local desktop's preferences store reads, so every
 * write goes through `persistAndBroadcastSettings` (the desktop's own
 * preferences converge on `ion:settings-changed`) and then announces
 * `ion:projects-changed` for the union-store picker on every client.
 *
 * `repoRemote` is stamped at registration (`ensureRepoRemote`), which is
 * what lets Transfer recognise the same repo on another Environment the
 * moment the project exists, rather than after its first export.
 */
import { existsSync, statSync, renameSync, rmSync, cpSync } from 'fs'
import { basename, dirname } from 'path'
import type { ProjectEntry, ProjectRegistry } from '@ion/shared/project-registry'
import { normalizeProjectDir } from '@ion/shared/project-registry'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import { PROJECTS_CHANGED_CHANNEL } from '@ion/shared/types-environment-admin'
import { readSettings, settingsFile } from '../persistence/settings-store'
import { persistAndBroadcastSettings } from '../settings-broadcast'
import { broadcast } from '../broadcast'
import { ensureRepoRemote, projectsIoFor } from '../transfer/repo-remote'
import { runGit } from '../git/git-runner'
import { loadRegistry, saveRegistry } from '../worktree/registry'
import { readProvisionManifest } from '../worktree/provision-manifest'
import { startWorktreeProvisioning } from '../worktree/provision-start'
import { runProvisionCommand } from '../worktree/provision-run'
import { startJob, progressJob, finishJob, failJob, runningJobFor } from './jobs'
import { isProjectTrusted, ProjectUntrustedError } from './project-trust'

export { isProjectTrusted, ProjectUntrustedError }
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.projects'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Setup outcomes this server lifetime, keyed by project dir; the list projects them onto rows. */
const setupStates = new Map<string, NonNullable<EnvironmentProject['setup']>>()

export function readProjectRegistry(): ProjectRegistry {
  const raw = readSettings().projects
  return raw && typeof raw === 'object' ? (raw as ProjectRegistry) : {}
}

function writeProjectRegistry(next: ProjectRegistry, reason: string): void {
  const prev = readSettings()
  persistAndBroadcastSettings({ ...prev, projects: next }, prev)
  log('registry written', { reason, project_count: Object.keys(next).length })
  broadcast(PROJECTS_CHANGED_CHANNEL, { reason })
}

async function originUrl(dir: string): Promise<string | undefined> {
  try {
    const out = (await runGit(dir, ['remote', 'get-url', 'origin'])).trim()
    return out || undefined
  } catch (err) {
    log('origin url read failed', { dir, error: String(err) })
    return undefined
  }
}

async function currentBranch(dir: string): Promise<string | undefined> {
  try {
    const out = (await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return out && out !== 'HEAD' ? out : undefined
  } catch (err) {
    log('branch read failed', { dir, error: String(err) })
    return undefined
  }
}

export async function listProjects(): Promise<EnvironmentProject[]> {
  let registry = readProjectRegistry()
  // A project registered before repository identity was stamped at add
  // time (the desktop's own registry predates it) is stamped here, so the
  // union picker and Copy from another environment can match it.
  let stamped = 0
  for (const [dir, entry] of Object.entries(registry)) {
    if (entry.repoRemote || !existsSync(`${dir}/.git`)) continue
    const remote = await ensureRepoRemote(dir, projectsIoFor(settingsFile()))
    if (remote) stamped++
  }
  if (stamped > 0) {
    registry = readProjectRegistry()
    log('repoRemote stamped on listing', { stamped })
  }
  // Usage counts live beside the registry in this host's own settings.json
  // (`addRecentBaseDirectory` bumps one every time work starts in a
  // directory), so the listing carries them and a client never has to guess
  // how much a project on another machine is used.
  const usageCounts = readSettings().directoryUsageCounts
  const usageFor = (dir: string): number | undefined => {
    const value = (usageCounts && typeof usageCounts === 'object') ? (usageCounts as Record<string, unknown>)[dir] : undefined
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  }
  const out: EnvironmentProject[] = []
  for (const [dir, entry] of Object.entries(registry)) {
    const exists = existsSync(dir)
    const isGitRepo = exists && existsSync(`${dir}/.git`)
    const setup = setupStates.get(dir)
    const setupCommand = exists ? readProvisionManifest(dir, { quiet: true }).setup : undefined
    out.push({
      dir,
      entry,
      displayName: entry.name?.trim() || basename(dir),
      exists,
      isGitRepo,
      ...(usageFor(dir) !== undefined ? { usageCount: usageFor(dir) } : {}),
      ...(isGitRepo ? { branch: await currentBranch(dir), originUrl: await originUrl(dir) } : {}),
      ...(setup ? { setup } : {}),
      ...(setupCommand ? { setupCommand } : {}),
      ...(entry.trusted === false ? { trusted: false } : {}),
    })
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
  log('listed', { project_count: out.length })
  return out
}

export interface AddProjectOptions {
  name?: string
  clonedByIon?: boolean
  cloneUrl?: string
  /** False registers a checkout whose code Ion must not run until `trustProject`. */
  trusted?: boolean
}

/** Registers `dir` (must exist on this host) and stamps its `repoRemote` when it is a git checkout with an origin. */
export async function addProject(dirInput: string, opts: AddProjectOptions = {}): Promise<EnvironmentProject> {
  const dir = normalizeProjectDir(dirInput)
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    warn('add refused: not a directory on this host', { dir })
    throw new Error(`${dir} is not a directory on this host`)
  }
  const registry = readProjectRegistry()
  const existing = registry[dir]
  const entry: ProjectEntry = {
    ...(existing ?? { addedManually: true, lastUsedAt: Date.now() }),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.clonedByIon ? { clonedByIon: true } : {}),
    ...(opts.cloneUrl ? { cloneUrl: opts.cloneUrl } : {}),
    ...(opts.trusted === false ? { trusted: false } : {}),
  }
  writeProjectRegistry({ ...registry, [dir]: entry }, existing ? 'add: updated' : 'add')
  if (existsSync(`${dir}/.git`)) {
    const remote = await ensureRepoRemote(dir, projectsIoFor(settingsFile()))
    if (remote) {
      // ensureRepoRemote persisted the field without a broadcast; re-announce
      // so every client's copy of the registry carries it.
      broadcast(PROJECTS_CHANGED_CHANNEL, { reason: 'repoRemote stamped' })
    }
    log('project added', { dir, repo_remote: remote ?? '', cloned_by_ion: !!opts.clonedByIon })
  } else {
    log('project added (not a git checkout)', { dir })
  }
  const listed = (await listProjects()).find((p) => p.dir === dir)
  if (!listed) throw new Error(`project ${dir} did not appear in the registry after add`)
  return listed
}

export interface RemovalAppraisal {
  dir: string
  registered: boolean
  clonedByIon: boolean
  exists: boolean
  /** Uncommitted changes, when it is a git checkout. */
  dirty: boolean
  /** Worktrees Ion cut from this checkout, which would also be orphaned. */
  worktrees: number
}

export async function appraiseRemoval(dirInput: string): Promise<RemovalAppraisal> {
  const dir = normalizeProjectDir(dirInput)
  const entry = readProjectRegistry()[dir]
  const exists = existsSync(dir)
  let dirty = false
  if (exists && existsSync(`${dir}/.git`)) {
    try { dirty = (await runGit(dir, ['status', '--porcelain', '-uall'])).trim().length > 0 } catch (err) { warn('dirty check failed; treating as dirty', { dir, error: String(err) }); dirty = true }
  }
  const worktrees = loadRegistry().filter((e) => e.repoPath === dir && !e.landedAt).length
  const appraisal = { dir, registered: !!entry, clonedByIon: entry?.clonedByIon === true, exists, dirty, worktrees }
  log('removal appraised', appraisal)
  return appraisal
}

export interface RemoveProjectOptions {
  /** Also delete the directory. Only allowed for a checkout Ion cloned (`clonedByIon`). */
  deleteFiles?: boolean
  /** Delete even when the checkout has uncommitted changes. */
  force?: boolean
}

export async function removeProject(dirInput: string, opts: RemoveProjectOptions = {}): Promise<{ removed: boolean; deletedFiles: boolean }> {
  const dir = normalizeProjectDir(dirInput)
  const registry = readProjectRegistry()
  const entry = registry[dir]
  if (!entry) {
    warn('remove: not registered', { dir })
    return { removed: false, deletedFiles: false }
  }
  let deletedFiles = false
  if (opts.deleteFiles) {
    const appraisal = await appraiseRemoval(dir)
    if (!appraisal.clonedByIon) {
      warn('remove refused: deleteFiles on a folder Ion did not clone', { dir })
      throw new Error(`${dir} was not cloned by Ion, so Ion will not delete it. Remove it from the registry only, or delete the folder yourself.`)
    }
    if (appraisal.dirty && !opts.force) {
      warn('remove refused: clone has uncommitted changes', { dir })
      throw new Error(`${dir} has uncommitted changes. Commit or push them, or choose to delete anyway.`)
    }
    if (appraisal.worktrees > 0 && !opts.force) {
      warn('remove refused: clone has live worktrees', { dir, worktrees: appraisal.worktrees })
      throw new Error(`${dir} still has ${appraisal.worktrees} worktree(s) cut from it. Retire them first, or choose to delete anyway.`)
    }
    if (appraisal.exists) {
      rmSync(dir, { recursive: true, force: true })
      deletedFiles = true
      log('clone deleted', { dir, forced: !!opts.force })
    }
  }
  const { [dir]: _removed, ...rest } = registry
  writeProjectRegistry(rest, deletedFiles ? 'remove + delete' : 'remove')
  setupStates.delete(dir)
  return { removed: true, deletedFiles }
}

/** Moves a project directory on disk and re-keys the registry and every worktree record that names it as its base. */
export async function relocateProject(fromInput: string, toInput: string): Promise<EnvironmentProject> {
  const from = normalizeProjectDir(fromInput)
  const to = normalizeProjectDir(toInput)
  const registry = readProjectRegistry()
  const entry = registry[from]
  if (!entry) throw new Error(`${from} is not a registered project`)
  if (!existsSync(from)) throw new Error(`${from} does not exist on this host`)
  if (existsSync(to)) throw new Error(`${to} already exists; choose an empty destination`)
  if (!existsSync(dirname(to))) throw new Error(`${dirname(to)} does not exist; create the parent folder first`)
  try {
    renameSync(from, to)
  } catch (err) {
    // Across filesystems rename fails; copy then remove, and say so in the log.
    warn('rename failed, copying instead', { from, to, error: String(err) })
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
  const { [from]: _old, ...rest } = registry
  writeProjectRegistry({ ...rest, [to]: entry }, 'relocate')
  const worktrees = loadRegistry()
  let rekeyed = 0
  for (const w of worktrees) {
    if (w.repoPath === from) { w.repoPath = to; rekeyed++ }
  }
  if (rekeyed > 0 && !saveRegistry(worktrees)) warn('worktree registry rewrite failed after relocate', { from, to, rekeyed })
  const setup = setupStates.get(from)
  if (setup) { setupStates.delete(from); setupStates.set(to, setup) }
  log('project relocated', { from, to, worktrees_rekeyed: rekeyed })
  const listed = (await listProjects()).find((p) => p.dir === to)
  if (!listed) throw new Error(`project ${to} did not appear in the registry after relocate`)
  return listed
}

/**
 * Marks a project's code as trusted to run. It is the operator's decision
 * and it is permanent; nothing Ion does afterwards reverses it.
 *
 * Every live worktree of the project is provisioned on the way: while the
 * project was untrusted, provisioning refused all of them, and trust is
 * never taken back, so each one that exists now was left as git made it.
 */
export async function trustProject(dirInput: string): Promise<EnvironmentProject> {
  const dir = normalizeProjectDir(dirInput)
  const registry = readProjectRegistry()
  const entry = registry[dir]
  if (!entry) {
    warn('trust refused: not a registered project', { dir })
    throw new Error(`${dir} is not a project on this host`)
  }
  if (entry.trusted === false) {
    const { trusted: _untrusted, ...rest } = entry
    writeProjectRegistry({ ...registry, [dir]: rest }, 'trust')
    const waiting = loadRegistry().filter((w) => w.repoPath === dir && !w.landedAt)
    log('project trusted', { dir, cloned_by_ion: entry.clonedByIon === true, worktrees_to_provision: waiting.length })
    for (const w of waiting) {
      log('trust: provisioning a worktree refused while untrusted', { dir, worktree_path: w.worktreePath })
      void startWorktreeProvisioning(dir, w.worktreePath)
    }
  } else {
    log('trust: project was already trusted', { dir })
  }
  const listed = (await listProjects()).find((p) => p.dir === dir)
  if (!listed) throw new Error(`project ${dir} did not appear in the registry after trust`)
  return listed
}

/**
 * Runs the project's own `setup` from `.ion/worktree.json` as a job. A
 * project with no manifest, or no setup, settles immediately as `none`;
 * that is a fact about the project, not a failure. A project Ion cloned is
 * refused until it is trusted: its setup is its own code.
 */
export function startSetup(dirInput: string): { jobId: string } {
  const dir = normalizeProjectDir(dirInput)
  if (!existsSync(dir)) throw new Error(`${dir} does not exist on this host`)
  if (!isProjectTrusted(dir)) {
    warn('setup refused: project is not trusted', { dir })
    throw new ProjectUntrustedError(dir)
  }
  const running = runningJobFor('setup', dir)
  if (running) {
    log('setup already running', { dir, job_id: running.id })
    return { jobId: running.id }
  }
  const plan = readProvisionManifest(dir)
  const job = startJob({ kind: 'setup', dir, stage: plan.setup ? 'running setup' : 'no setup recipe' }, null)
  setupStates.set(dir, { state: 'running', at: Date.now() })
  if (!plan.setup) {
    setupStates.set(dir, { state: 'none', detail: 'the project declares no setup in .ion/worktree.json', at: Date.now() })
    finishJob(job.id)
    return { jobId: job.id }
  }
  const command = plan.setup
  progressJob(job.id, { detail: command })
  void runProvisionCommand(command, dir).then((result) => {
    const tail = result.output.split('\n').filter((l) => l.trim()).slice(-3).join(' | ')
    if (result.ok) {
      setupStates.set(dir, { state: 'ready', detail: tail, at: Date.now() })
      finishJob(job.id)
    } else {
      const reason = result.timedOut ? 'setup timed out' : result.error ?? `exit ${result.exitCode}`
      setupStates.set(dir, { state: 'failed', detail: `${reason}: ${tail}`, at: Date.now() })
      failJob(job.id, `${command}: ${reason}\n${result.output.split('\n').slice(-12).join('\n')}`)
    }
    broadcast(PROJECTS_CHANGED_CHANNEL, { reason: 'setup finished' })
  })
  return { jobId: job.id }
}

export function _resetSetupStatesForTest(): void { setupStates.clear() }
