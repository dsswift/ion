/**
 * environment/jobs — the registry of background work an Environment runs
 * on a project (a clone, a setup, a purge), and the one place their
 * progress is published from.
 *
 * Every mutation broadcasts the job's full snapshot on `ion:project-job`
 * (environment-scoped, see `@ion/shared/studio-wire/channels`), so a client
 * that attaches mid-job renders the same toast as the one that started it,
 * and closing a dialog never loses the job: it lives here, not in a
 * renderer. Finished jobs are kept for `FINISHED_RETENTION_MS` so a late
 * `list` still sees the outcome, then dropped.
 */
import { randomUUID } from 'crypto'
import type { EnvironmentJob } from '@ion/shared/types-environment-admin'
import { PROJECT_JOB_CHANNEL } from '@ion/shared/types-environment-admin'
import { broadcast } from '../broadcast'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.jobs'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

const FINISHED_RETENTION_MS = 10 * 60 * 1000

interface Entry {
  job: EnvironmentJob
  cancel: (() => void) | null
  retention: NodeJS.Timeout | null
}

const jobs = new Map<string, Entry>()

function publish(entry: Entry): void {
  broadcast(PROJECT_JOB_CHANNEL, { ...entry.job })
}

/** Starts tracking a job. `cancel` is invoked by `cancelJob`; the runner must then settle the job itself. */
export function startJob(init: Pick<EnvironmentJob, 'kind' | 'dir' | 'stage'> & { url?: string }, cancel: (() => void) | null): EnvironmentJob {
  const job: EnvironmentJob = { id: randomUUID(), kind: init.kind, dir: init.dir, phase: 'running', stage: init.stage, startedAt: Date.now(), ...(init.url ? { url: init.url } : {}) }
  const entry: Entry = { job, cancel, retention: null }
  jobs.set(job.id, entry)
  log('job started', { job_id: job.id, kind: job.kind, dir: job.dir, url: job.url ?? '' })
  publish(entry)
  return { ...job }
}

/** Updates a running job's stage/progress line. No-op once the job has settled. */
export function progressJob(id: string, patch: { stage?: string; percent?: number; detail?: string }): void {
  const entry = jobs.get(id)
  if (!entry || entry.job.phase !== 'running') return
  if (patch.stage !== undefined) entry.job.stage = patch.stage
  if (patch.percent !== undefined) entry.job.percent = patch.percent
  if (patch.detail !== undefined) entry.job.detail = patch.detail
  publish(entry)
}

function settle(id: string, phase: 'done' | 'failed' | 'cancelled', error?: string): void {
  const entry = jobs.get(id)
  if (!entry || entry.job.phase !== 'running') return
  entry.job.phase = phase
  entry.job.endedAt = Date.now()
  if (error) entry.job.error = error
  entry.cancel = null
  if (phase === 'done') log('job done', { job_id: id, kind: entry.job.kind, dir: entry.job.dir, duration_ms: entry.job.endedAt - entry.job.startedAt })
  else warn('job ended without success', { job_id: id, kind: entry.job.kind, dir: entry.job.dir, phase, error: error ?? '' })
  publish(entry)
  entry.retention = setTimeout(() => { jobs.delete(id) }, FINISHED_RETENTION_MS)
  entry.retention.unref?.()
}

export function finishJob(id: string): void { settle(id, 'done') }
export function failJob(id: string, error: string): void { settle(id, 'failed', error) }
export function markJobCancelled(id: string): void { settle(id, 'cancelled') }

/** Asks a running job to stop. Returns false when the job is unknown, already settled, or not cancellable. */
export function cancelJob(id: string): boolean {
  const entry = jobs.get(id)
  if (!entry || entry.job.phase !== 'running' || !entry.cancel) {
    log('cancel refused', { job_id: id, known: !!entry, phase: entry?.job.phase ?? 'unknown', cancellable: !!entry?.cancel })
    return false
  }
  log('cancel requested', { job_id: id, kind: entry.job.kind, dir: entry.job.dir })
  entry.cancel()
  return true
}

export function getJob(id: string): EnvironmentJob | undefined {
  const entry = jobs.get(id)
  return entry ? { ...entry.job } : undefined
}

export function listJobs(): EnvironmentJob[] {
  return [...jobs.values()].map((e) => ({ ...e.job })).sort((a, b) => b.startedAt - a.startedAt)
}

/** The running job of `kind` on `dir`, if any: the guard against two clones into one folder. */
export function runningJobFor(kind: EnvironmentJob['kind'], dir: string): EnvironmentJob | undefined {
  for (const entry of jobs.values()) {
    if (entry.job.phase === 'running' && entry.job.kind === kind && entry.job.dir === dir) return { ...entry.job }
  }
  return undefined
}

export function _resetJobsForTest(): void {
  for (const entry of jobs.values()) if (entry.retention) clearTimeout(entry.retention)
  jobs.clear()
}
