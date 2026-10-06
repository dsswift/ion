/**
 * project-rows — what the Projects list shows, as data. One row per project
 * and one per job that has no project yet (a clone still running, a clone
 * that failed), each with the one status the row's chip and dot carry.
 * Pure, so the list's ordering and status rules are tested without React.
 */
import { ENVIRONMENT_JOB_VERB, type EnvironmentJob, type EnvironmentProject } from '@ion/shared/types-environment-admin'
import type { Tone } from '../kit'
import { pathBasename, pathDirname } from '@ion/shared/paths'

export type ProjectListRow =
  | { kind: 'project'; key: string; project: EnvironmentProject; job: EnvironmentJob | undefined }
  | { kind: 'job'; key: string; job: EnvironmentJob }

export interface RowStatus {
  /** The chip text, or null when the row needs none. */
  chip: string | null
  chipTone: Tone
  dot: Tone
  /** What the dot means, for its tooltip. */
  dotLabel: string
}

function withPercent(text: string, job: EnvironmentJob): string {
  return job.percent !== undefined ? `${text} ${job.percent}%` : text
}

export function jobProgressLabel(job: EnvironmentJob): string {
  return withPercent(ENVIRONMENT_JOB_VERB[job.kind], job)
}

/** The folder name a clone of `url` lands in: the last path segment without `.git`. */
export function repoNameFromUrl(url: string): string {
  return url.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? ''
}

export function baseName(path: string): string {
  return pathBasename(path)
}

export function jobRowName(job: EnvironmentJob): string {
  return (job.url ? repoNameFromUrl(job.url) : '') || baseName(job.dir)
}

/**
 * Job rows first (running jobs whose folder is not a project yet, then
 * failed clones and creates), then every project sorted by name. A running
 * job whose folder IS a project rides on that project's row instead. One
 * folder shows one running job: a create, which carries its own clone's
 * progress, over the clone or setup it started.
 */
export function buildProjectRows(projects: readonly EnvironmentProject[], jobs: readonly EnvironmentJob[]): ProjectListRow[] {
  const running = jobs.filter((j) => j.phase === 'running')
  const shown = running.filter((j) => j.kind === 'create' || !running.some((o) => o.kind === 'create' && o.dir === j.dir))
  const failed = jobs.filter((j) => j.phase === 'failed' && (j.kind === 'clone' || j.kind === 'create'))
  const dirs = new Set(projects.map((p) => p.dir))
  const jobRows: ProjectListRow[] = [...shown.filter((j) => !dirs.has(j.dir)), ...failed].map((job) => ({ kind: 'job', key: `job:${job.id}`, job }))
  const projectRows: ProjectListRow[] = [...projects]
    .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
    .map((project) => ({ kind: 'project', key: project.dir, project, job: shown.find((j) => j.dir === project.dir) }))
  return [...jobRows, ...projectRows]
}

export function projectStatus(project: EnvironmentProject, job: EnvironmentJob | undefined): RowStatus {
  const setupRunning = project.setup?.state === 'running'
  const untrusted = project.trusted === false
  const dot: Tone = !project.exists ? 'error' : untrusted || job !== undefined || setupRunning || project.setup?.state === 'failed' ? 'warn' : 'ok'
  const dotLabel = !project.exists ? 'Missing on disk' : untrusted ? 'Not trusted' : job || setupRunning ? 'Working' : project.setup?.state === 'failed' ? 'Setup failed' : 'Ready'
  const status = (chip: string | null, chipTone: Tone): RowStatus => ({ chip, chipTone, dot, dotLabel })
  if (!project.exists) return status('missing', 'error')
  if (untrusted) return status('not trusted', 'warn')
  if (job) return status(jobProgressLabel(job), 'warn')
  if (setupRunning) return status('setting up', 'warn')
  if (project.setup?.state === 'failed') return status('setup failed', 'error')
  if (!project.isGitRepo) return status('not git', 'muted')
  if (project.entry.clonedByIon) return status('cloned by Ion', 'muted')
  return status(null, 'muted')
}

export function jobStatus(job: EnvironmentJob): RowStatus {
  if (job.phase === 'failed') {
    const what = job.kind === 'create' ? 'Create' : 'Clone'
    return { chip: `${what.toLowerCase()} failed`, chipTone: 'error', dot: 'error', dotLabel: job.error ? `${what} failed: ${job.error}` : `${what} failed` }
  }
  return { chip: jobProgressLabel(job), chipTone: 'warn', dot: 'warn', dotLabel: 'Working' }
}

/** The list filter: a project by name, path, or branch; a job by name, folder, or URL. */
export function rowMatches(row: ProjectListRow, query: string): boolean {
  const fields = row.kind === 'project'
    ? [row.project.displayName, row.project.dir, row.project.branch ?? '']
    : [jobRowName(row.job), row.job.dir, row.job.url ?? '']
  return fields.some((f) => f.toLowerCase().includes(query))
}

/** Splits what was typed in the folder box into the folder to list and the filter for its entries. */
export function splitTypedPath(typed: string): { listPath: string; filter: string } {
  const value = typed.trim() || '~'
  if (value === '~' || value === '/') return { listPath: value, filter: '' }
  // Either separator: a Windows path is typed with backslashes.
  if (/[\\/]$/.test(value)) return { listPath: value.slice(0, -1) || '/', filter: '' }
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (cut === -1) return { listPath: '~', filter: value }
  return { listPath: pathDirname(value), filter: value.slice(cut + 1) }
}
