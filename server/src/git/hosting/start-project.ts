/**
 * `gitHosting.startProject`: a new project from one request. Create the
 * repository on a git host, clone it onto this server trusted, open a
 * conversation in the checkout on the chosen model, and send it the
 * opening prompt. It runs as one `create` job, so the client that asked
 * can go away at any step and every client follows it on
 * `ion:project-job`; the job names the conversation (`tabId`) once it is
 * open.
 *
 * What each step produced is kept by the client's `requestId`. Asked again
 * while its job runs, the answer is that job. Asked again after it failed,
 * a new job resumes at the step that failed, so a clone that failed after
 * the repository was made never makes it twice.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import type { GitHostingRepository, GitHostingStartProjectRequest, GitHostingStartProjectStarted } from '@ion/shared/types-git-hosting'
import { expandHome } from '../../environment/fs-browse'
import { startClone } from '../../environment/clone'
import { chooseCloneUrl } from '../../environment/clone-url'
import { awaitJobSettled, cancelJob, failJob, finishJob, getJob, markJobCancelled, progressJob, startJob } from '../../environment/jobs'
import { createTabForClient, notifyTabCreated } from '../../remote/handlers/tabs-create-echo'
import { submitClientPrompt, type PromptOrigin } from '../../remote/handlers/tabs-prompt'
import { useSessionStore } from '../../store/sessionStore'
import { createRepositoryAs, message } from './create'
import { log as _log, warn as _warn } from '../../logger'

const TAG = 'git-hosting.start-project'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** What one request has produced so far. */
interface Progress {
  jobId: string
  repository?: GitHostingRepository
  dir?: string
  tabId?: string
  /** Every step is done; a repeat answers the finished job. */
  finished?: boolean
}

const byRequest = new Map<string, Progress>()
const REQUESTS_CAP = 64

function remember(requestId: string, progress: Progress): void {
  byRequest.delete(requestId)
  byRequest.set(requestId, progress)
  while (byRequest.size > REQUESTS_CAP) {
    const oldest = byRequest.keys().next().value
    if (oldest === undefined) break
    byRequest.delete(oldest)
  }
}

class Cancelled extends Error {}

/** A request the server refused before any job started. */
export class StartProjectRefusal extends Error {}

/** Starts (or resumes, or answers) the `create` job for `request`. Throws `StartProjectRefusal`. */
export function startProject(subject: string, request: GitHostingStartProjectRequest, origin: PromptOrigin): GitHostingStartProjectStarted {
  const target = join(expandHome(request.parentDir), request.name)
  const known = byRequest.get(request.requestId)
  const knownJob = known ? getJob(known.jobId) : undefined
  if (known && (known.finished || knownJob?.phase === 'running')) {
    log('start project: request already running or finished, answering its job', { request_id: request.requestId, job_id: known.jobId, finished: known.finished === true })
    return { jobId: known.jobId, dir: known.dir ?? target }
  }
  // Checked before the repository is made: a clone that cannot land would
  // leave a repository on the host and nothing here.
  if (!known?.dir && existsSync(target)) {
    warn('start project refused: destination exists', { request_id: request.requestId, dir: target })
    throw new StartProjectRefusal(`${target} already exists on this host. Pick another name.`)
  }

  let cancelled = false
  let cloneJobId: string | null = null
  const job = startJob({ kind: 'create', dir: known?.dir ?? target, stage: 'starting' }, () => {
    cancelled = true
    if (cloneJobId) cancelJob(cloneJobId)
  })
  const progress: Progress = { ...known, jobId: job.id }
  remember(request.requestId, progress)
  log('start project: job started', {
    request_id: request.requestId, job_id: job.id, subject, git_host: request.host, name: request.name,
    resumed_from: known ? (known.tabId ? 'prompt' : known.dir ? 'conversation' : known.repository ? 'clone' : 'create') : 'none',
    model: request.model ?? '', profile_id: request.profileId ?? '', has_prompt: request.prompt.trim().length > 0,
  })

  const checkpoint = (): void => { if (cancelled) throw new Cancelled() }

  const run = async (): Promise<void> => {
    if (!progress.repository) {
      progressJob(job.id, { stage: 'creating repository' })
      progress.repository = await createRepositoryAs(subject, request)
    }
    checkpoint()
    if (!progress.dir) {
      const repository = progress.repository
      progressJob(job.id, { stage: 'cloning' })
      const url = await chooseCloneUrl(subject, { sshUrl: repository.sshUrl, httpsUrl: repository.httpsUrl })
      const started = await startClone({ url, parentDir: request.parentDir, name: repository.name, trust: true })
      cloneJobId = started.jobId
      log('start project: clone started', { request_id: request.requestId, job_id: job.id, clone_job_id: started.jobId, dir: started.dir })
      const settled = await awaitJobSettled(started.jobId, (clone) => progressJob(job.id, { stage: `cloning: ${clone.stage}`, percent: clone.percent ?? null, detail: clone.detail ?? null }))
      cloneJobId = null
      checkpoint()
      if (settled?.phase !== 'done') throw new Error(settled?.error ?? 'The clone did not finish.')
      progress.dir = started.dir
    }
    if (!progress.tabId) {
      progressJob(job.id, { stage: 'opening conversation', percent: null, detail: null })
      const tabId = await createTabForClient({ workingDirectory: progress.dir, profileId: request.profileId })
      if (!tabId) throw new Error(`A conversation could not be opened in ${progress.dir}.`)
      // Before the first prompt, so that prompt already runs on the pick.
      if (request.model) useSessionStore.getState().setTabModel(tabId, request.model, request.providerId)
      progress.tabId = tabId
      log('start project: conversation opened', { request_id: request.requestId, job_id: job.id, tab_id: tabId, model: request.model ?? '' })
      await notifyTabCreated(tabId)
    }
    const tabId = progress.tabId
    progressJob(job.id, { tabId })
    if (request.prompt.trim()) {
      progressJob(job.id, { stage: 'sending prompt' })
      const outcome = await submitClientPrompt({ tabId, text: request.prompt, ...(request.profileId ? { instanceId: '' } : {}) }, origin)
      if (!outcome.accepted) throw new Error(`The conversation is open, but the prompt was not accepted: ${outcome.reason ?? 'no reason given'}`)
      log('start project: prompt accepted', { request_id: request.requestId, job_id: job.id, tab_id: tabId })
    } else {
      log('start project: no prompt to send', { request_id: request.requestId, job_id: job.id, tab_id: tabId })
    }
    progress.finished = true
    finishJob(job.id)
  }

  void run().catch((err: unknown) => {
    if (err instanceof Cancelled) {
      log('start project: cancelled', { request_id: request.requestId, job_id: job.id })
      markJobCancelled(job.id)
      return
    }
    warn('start project: failed', { request_id: request.requestId, job_id: job.id, created: !!progress.repository, cloned: !!progress.dir, opened: !!progress.tabId, error: message(err) })
    failJob(job.id, message(err))
  })
  return { jobId: job.id, dir: progress.dir ?? target }
}

export function _resetStartProjectForTest(): void {
  byRequest.clear()
}
