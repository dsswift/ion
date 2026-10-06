/**
 * fleet-clone — one repository cloned onto several servers at once. Each
 * target gets its own `environment.projects.clone`, into that server's own
 * clone folder, and is followed through the server's `ion:project-job`
 * snapshots until its clone is registered as a project or fails. The clones
 * are the servers' jobs: closing whatever started them does not stop them.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EnvironmentJob } from '@ion/shared/types-environment-admin'
import { PROJECT_JOB_CHANNEL } from '@ion/shared/types-environment-admin'
import type { GitCloneRemote } from '@ion/shared/types-git-hosting'
import { environmentClient, onEnvironmentEvent, readCloneBaseDir } from '../../components/settings/environment/environment-client'
import { rInfo, rWarn } from '../../rendererLogger'

const TAG = 'new-project.fleet-clone'

export interface FleetCloneTarget {
  environmentId: string
  label: string
}

export type FleetCloneState =
  | { phase: 'queued' }
  | { phase: 'cloning'; dir: string; stage: string; percent?: number }
  | { phase: 'done'; dir: string }
  | { phase: 'failed'; error: string }

export interface FleetCloneRequest {
  targets: readonly FleetCloneTarget[]
  /** One URL, or a new repository's SSH and HTTPS pair for each server to pick from. */
  source: string | GitCloneRemote
  /** The folder name on every server. */
  name: string
  /** Register the clones trusted, so their setup runs as they land. */
  trust: boolean
  onState(environmentId: string, state: FleetCloneState): void
}

export function isSettled(state: FleetCloneState | undefined): boolean {
  return state?.phase === 'done' || state?.phase === 'failed'
}

function stateOf(job: EnvironmentJob): FleetCloneState {
  if (job.phase === 'done') return { phase: 'done', dir: job.dir }
  if (job.phase === 'failed') return { phase: 'failed', error: job.error ?? 'The clone failed.' }
  if (job.phase === 'cancelled') return { phase: 'failed', error: 'The clone was cancelled.' }
  return { phase: 'cloning', dir: job.dir, stage: job.stage, ...(job.percent === undefined ? {} : { percent: job.percent }) }
}

function cloneOnto(target: FleetCloneTarget, request: FleetCloneRequest): () => void {
  let jobId: string | null = null
  let stopped = false
  // A fast clone can finish before the action that started it answers, so snapshots are held until its id is known.
  const early: EnvironmentJob[] = []
  const apply = (job: EnvironmentJob): void => {
    if (stopped || job.id !== jobId) return
    const state = stateOf(job)
    request.onState(target.environmentId, state)
    if (isSettled(state)) {
      rInfo(TAG, 'clone settled', { environment_id: target.environmentId, job_id: job.id, phase: state.phase, ...(state.phase === 'failed' ? { error: state.error } : {}) })
      stop()
    }
  }
  const off = onEnvironmentEvent(target.environmentId, PROJECT_JOB_CHANNEL, (payload) => {
    const job = payload as EnvironmentJob
    if (jobId === null) early.push(job)
    else apply(job)
  })
  const stop = (): void => { stopped = true; off() }
  request.onState(target.environmentId, { phase: 'queued' })
  void readCloneBaseDir(target.environmentId)
    .then((parentDir) => environmentClient.cloneProject(target.environmentId, request.source, parentDir, request.name, request.trust))
    .then((started) => {
      if (stopped) return
      jobId = started.jobId
      rInfo(TAG, 'clone started', { environment_id: target.environmentId, job_id: started.jobId, dir: started.dir, trust: request.trust })
      request.onState(target.environmentId, { phase: 'cloning', dir: started.dir, stage: 'starting' })
      for (const job of early) apply(job)
    })
    .catch((err: unknown) => {
      rWarn(TAG, 'clone could not start', { environment_id: target.environmentId, error: String(err) })
      if (!stopped) request.onState(target.environmentId, { phase: 'failed', error: err instanceof Error ? err.message : String(err) })
      stop()
    })
  return stop
}

/** Starts a clone on every target at once. Returns a function that stops following them; the clones themselves carry on. */
export function startFleetClone(request: FleetCloneRequest): () => void {
  rInfo(TAG, 'fleet clone started', { servers: request.targets.map((t) => t.environmentId), name: request.name, source: typeof request.source === 'string' ? 'url' : 'remote' })
  const stops = request.targets.map((target) => cloneOnto(target, request))
  return () => { for (const stop of stops) stop() }
}

export interface FleetCloneRun {
  /** The targets of the run, in the order they were given; empty before a run starts. */
  targets: readonly FleetCloneTarget[]
  states: Readonly<Record<string, FleetCloneState>>
  /** A run is under way or over, and every target has finished or failed. */
  settled: boolean
  start(request: Omit<FleetCloneRequest, 'onState'>): void
  /** Clones again onto one target whose clone failed. */
  retry(environmentId: string): void
}

/** A fleet clone a component follows for as long as it is mounted. */
export function useFleetClone(): FleetCloneRun {
  const [targets, setTargets] = useState<readonly FleetCloneTarget[]>([])
  const [states, setStates] = useState<Record<string, FleetCloneState>>({})
  const request = useRef<Omit<FleetCloneRequest, 'onState'> | null>(null)
  const stops = useRef<Array<() => void>>([])
  useEffect(() => () => { for (const stop of stops.current) stop() }, [])
  const onState = useCallback((environmentId: string, state: FleetCloneState): void => {
    setStates((prev) => ({ ...prev, [environmentId]: state }))
  }, [])
  const start = useCallback((next: Omit<FleetCloneRequest, 'onState'>): void => {
    for (const stop of stops.current) stop()
    request.current = next
    setTargets(next.targets)
    setStates({})
    stops.current = [startFleetClone({ ...next, onState })]
  }, [onState])
  const retry = useCallback((environmentId: string): void => {
    const held = request.current
    const target = held?.targets.find((t) => t.environmentId === environmentId)
    if (!held || !target) return
    stops.current.push(startFleetClone({ ...held, targets: [target], onState }))
  }, [onState])
  const settled = targets.length > 0 && targets.every((t) => isSettled(states[t.environmentId]))
  return { targets, states, settled, start, retry }
}
