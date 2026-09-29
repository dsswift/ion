/**
 * environment/clone — `environment.projects.clone`: clone a repository
 * onto THIS host as a job, with git's own progress streamed to every
 * client, then register it as a project, marked `clonedByIon`. It is
 * untrusted, so nothing in it runs until the operator trusts it
 * (`project-trust.ts`), unless they trusted it when they asked for the
 * clone: then it registers trusted and its setup runs as soon as it lands.
 *
 * git is spawned directly rather than through `runGit` because a clone's
 * progress only exists on stderr as it happens (`Receiving objects: 45%`),
 * which a buffered exec cannot report. The credential environment is the
 * same one `runGit` would use (`resolveGitEnvFor`), so a key or token the
 * principal stored for the remote's host is what the clone authenticates
 * with.
 */
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { resolveGitEnvFor } from '../git/git-runner'
import { expandHome } from './fs-browse'
import { addProject, startSetup } from './projects'
import { startJob, progressJob, finishJob, failJob, markJobCancelled, runningJobFor } from './jobs'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.clone'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** `git@github.com:org/repo.git` and `https://host/org/repo` both name the folder `repo`. */
export function cloneDirectoryName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const last = trimmed.split(/[/:]/).pop() ?? ''
  return last.replace(/\.git$/, '') || 'repo'
}

/** Parses one git progress line into a stage and a percentage, when it carries one. */
export function parseCloneProgress(line: string): { stage: string; percent?: number } | null {
  const m = /^(remote: )?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Enumerating objects|Checking out files):\s*(\d+)%/.exec(line.trim())
  if (m) return { stage: m[2].toLowerCase(), percent: Number(m[3]) }
  if (/^Cloning into/.test(line)) return { stage: 'cloning' }
  return null
}

export interface StartCloneArgs {
  url: string
  /** The folder the clone lands under; `~` is the server user's home. */
  parentDir: string
  /** Folder name; defaults to the repository's name. */
  name?: string
  /**
   * The operator trusted the project when they asked for the clone, so it
   * registers trusted and its setup runs the moment the clone lands.
   * Absent or false registers it untrusted: nothing in it runs.
   */
  trust?: boolean
}

export async function startClone(args: StartCloneArgs): Promise<{ jobId: string; dir: string }> {
  const url = args.url.trim()
  if (!url) throw new Error('a repository URL is required')
  const parent = expandHome(args.parentDir)
  const dir = join(parent, (args.name ?? cloneDirectoryName(url)).trim())
  if (existsSync(dir)) {
    warn('clone refused: destination exists', { dir })
    throw new Error(`${dir} already exists on this host. Add it as a project instead, or pick another folder.`)
  }
  const running = runningJobFor('clone', dir)
  if (running) {
    log('clone already running', { dir, job_id: running.id })
    return { jobId: running.id, dir }
  }
  mkdirSync(parent, { recursive: true })
  const env = await resolveGitEnvFor(parent, ['clone', url])
  let child: ChildProcess | null = null
  let cancelled = false
  const job = startJob({ kind: 'clone', dir, stage: 'starting', url }, () => {
    cancelled = true
    child?.kill('SIGTERM')
  })
  const tail: string[] = []
  const onLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    tail.push(trimmed)
    if (tail.length > 20) tail.shift()
    const progress = parseCloneProgress(trimmed)
    progressJob(job.id, progress ? { ...progress, detail: trimmed } : { detail: trimmed })
  }
  try {
    child = spawn('git', ['clone', '--progress', url, dir], { cwd: parent, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    failJob(job.id, `could not start git: ${String(err)}`)
    return { jobId: job.id, dir }
  }
  log('clone spawned', { job_id: job.id, url, dir, pid: child.pid ?? 0 })
  let pending = ''
  const feed = (chunk: Buffer): void => {
    // git rewrites progress lines with \r; treat both terminators as line ends.
    pending += chunk.toString('utf-8')
    const parts = pending.split(/\r\n|\r|\n/)
    pending = parts.pop() ?? ''
    for (const part of parts) onLine(part)
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', feed)
  child.on('error', (err) => {
    warn('clone process error', { job_id: job.id, error: err.message })
    failJob(job.id, `git clone failed to run: ${err.message}`)
  })
  child.on('close', (code) => {
    if (pending.trim()) onLine(pending)
    if (cancelled) {
      rmSync(dir, { recursive: true, force: true })
      log('clone cancelled; partial checkout removed', { job_id: job.id, dir })
      markJobCancelled(job.id)
      return
    }
    if (code !== 0) {
      rmSync(dir, { recursive: true, force: true })
      warn('clone failed', { job_id: job.id, url, dir, exit_code: code, tail: tail.slice(-5) })
      failJob(job.id, `git clone exited ${code}:\n${tail.slice(-8).join('\n')}`)
      return
    }
    progressJob(job.id, { stage: 'registering', percent: 100, detail: dir })
    // Untrusted unless the operator trusted it when asking for the clone: a
    // checkout Ion fetched is someone else's code until they say otherwise,
    // so nothing in it runs — not its setup, not a worktree's seed builds.
    const trusted = args.trust === true
    void addProject(dir, { clonedByIon: true, cloneUrl: url, name: basename(dir), ...(trusted ? {} : { trusted: false }) }).then(() => {
      log(trusted ? 'clone registered as a trusted project' : 'clone registered as an untrusted project', { job_id: job.id, dir })
      finishJob(job.id)
      if (!trusted) return
      try {
        const setup = startSetup(dir)
        log('clone: setup started for the trusted clone', { job_id: job.id, setup_job_id: setup.jobId, dir })
      } catch (err) {
        warn('clone: setup could not start for the trusted clone', { job_id: job.id, dir, error: String(err) })
      }
    }).catch((err: unknown) => {
      warn('clone succeeded but registration failed', { job_id: job.id, dir, error: String(err) })
      failJob(job.id, `cloned, but could not register the project: ${String(err)}`)
    })
  })
  return { jobId: job.id, dir }
}
