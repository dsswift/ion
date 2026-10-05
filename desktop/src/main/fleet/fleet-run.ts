/**
 * fleet-run — runs the bundled `ion fleet` for the Fleet page.
 *
 * Deploying from source needs this device's checkout, build tools, and SSH
 * keys, so it runs here and not on a server. The Go fleet is the one
 * implementation of a deploy: this starts it with `--events` and passes
 * each line it prints to the page, so the page and the terminal dashboard
 * do the same thing. The same command checks what a deploy would do (a dry
 * run) and makes a host able to build.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { FLEET_RUN_LOG_KEPT, parseFleetDeployEvent, type FleetRunProgress, type FleetRunRequest, type FleetRunSnapshot, type FleetRunStart } from '@ion/shared/types-fleet-run'
import { findBundledBinary } from '@ion/server/engine/engine-bootstrap'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'fleet-run'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export type FleetSpawn = (bin: string, args: string[]) => ChildProcess

export interface FleetRunDeps {
  /** The `ion` binary this desktop carries; null when it has none. */
  binary?: () => string | null
  spawn?: FleetSpawn
}

const usable = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && !value.startsWith('-')

/** The `ion fleet` arguments of a request, or why the request is not one. `runId` names a deploy that is not a dry run. */
export function fleetArgs(request: FleetRunRequest, runId?: string): string[] | string {
  switch (request.kind) {
    case 'migrate':
      return ['fleet', 'migrate']
    case 'builder': {
      if (!usable(request.host)) return 'name the server to prepare'
      if (!request.installTools && !request.excludeBuildDir) return 'say what to fix on the server'
      if (request.source !== undefined && !usable(request.source)) return 'say which Ion checkout to use: dev, or a path to one'
      return [
        'fleet', 'builder', request.host, '--events',
        ...(request.installTools ? ['--install-tools'] : []),
        ...(request.excludeBuildDir ? ['--exclude-build-dir'] : []),
        ...(request.source ? ['--source', request.source.trim()] : []),
      ]
    }
    case 'set-build-dir':
      if (!usable(request.host)) return 'name the server whose build folder to set'
      if (!usable(request.buildDir)) return 'name the folder the server builds in'
      return ['fleet', 'set', request.host, '--build-dir', request.buildDir.trim()]
    case 'deploy': {
      const ids = Array.isArray(request.environmentIds) ? request.environmentIds.filter(usable) : []
      if (ids.length === 0) return 'name at least one server to deploy to'
      if (!usable(request.source)) return 'say what to deploy: dev, release, or a path to an Ion checkout'
      const releaseFor = Array.isArray(request.releaseFor) ? request.releaseFor.filter(usable) : []
      return [
        'fleet', 'deploy', ...ids, '--source', request.source.trim(), '--events',
        ...(request.overSsh ? ['--over-ssh'] : []),
        ...(request.allowDowngrade ? ['--allow-downgrade'] : []),
        ...(releaseFor.length > 0 ? ['--release-for', releaseFor.join(',')] : []),
        ...(request.dryRun ? ['--dry-run'] : runId ? ['--run-id', runId] : []),
      ]
    }
    default:
      return 'unknown fleet command'
  }
}

const running = new Map<string, ChildProcess>()

/** The deploys this process started, newest last: the one running and the last to end. */
const deploys = new Map<string, FleetRunSnapshot>()
const DEPLOYS_KEPT = 2

function rememberDeploy(runId: string): FleetRunSnapshot {
  const snapshot: FleetRunSnapshot = { runId, running: true, exitCode: null, log: [] }
  deploys.set(runId, snapshot)
  for (const id of [...deploys.keys()].slice(0, Math.max(0, deploys.size - DEPLOYS_KEPT))) {
    if (!deploys.get(id)?.running) deploys.delete(id)
  }
  return snapshot
}

/** A stdout line of a deploy that is a log event, kept for a page that opens later. */
function keepLogLine(snapshot: FleetRunSnapshot, line: string): void {
  const event = parseFleetDeployEvent(line)
  if (event?.event !== 'log') return
  snapshot.log.push({ hosts: event.hosts, line: event.line })
  if (snapshot.log.length > FLEET_RUN_LOG_KEPT) snapshot.log.splice(0, snapshot.log.length - FLEET_RUN_LOG_KEPT)
}

/** The deploys this process started and still remembers, with their logs. */
export function fleetRunSnapshots(): FleetRunSnapshot[] {
  return [...deploys.values()]
}

/** TEST ONLY. */
export function _resetFleetRunsForTest(): void {
  running.clear()
  deploys.clear()
}

/**
 * Starts a fleet command and returns its run id at once. Every line it
 * prints, and its exit, go to `onProgress`. A deploy that is not a dry run is
 * remembered with its log until a later one replaces it.
 */
export function startFleetRun(request: FleetRunRequest, onProgress: (progress: FleetRunProgress) => void, deps: FleetRunDeps = {}): FleetRunStart {
  const runId = randomUUID()
  const args = fleetArgs(request, runId)
  if (typeof args === 'string') {
    warn('fleet run refused', { kind: request?.kind, reason: args })
    return { ok: false, error: args }
  }
  const bin = (deps.binary ?? findBundledBinary)()
  if (!bin) {
    warn('fleet run refused: no ion binary in this build')
    return { ok: false, error: 'This Ion build carries no ion command to run the fleet with.' }
  }
  let child: ChildProcess
  try {
    child = (deps.spawn ?? ((b, a) => spawn(b, a, { stdio: ['ignore', 'pipe', 'pipe'] })))(bin, args)
  } catch (err) {
    warn('fleet run could not start', { error: String(err) })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  running.set(runId, child)
  const snapshot = request.kind === 'deploy' && !request.dryRun ? rememberDeploy(runId) : null
  log('fleet run started', { run_id: runId, kind: request.kind, pid: child.pid ?? 0, args })
  const lines = (stream: 'stdout' | 'stderr'): void => {
    const source = child[stream]
    if (!source) return
    createInterface({ input: source }).on('line', (line) => {
      if (snapshot && stream === 'stdout') keepLogLine(snapshot, line)
      onProgress({ runId, type: 'line', stream, line })
    })
  }
  lines('stdout')
  lines('stderr')
  let ended = false
  const end = (code: number | null, error?: string): void => {
    if (ended) return
    ended = true
    running.delete(runId)
    if (snapshot) Object.assign(snapshot, { running: false, exitCode: code, ...(error ? { error } : {}) })
    log('fleet run ended', { run_id: runId, kind: request.kind, exit_code: code, error: error ?? '' })
    onProgress({ runId, type: 'exit', code, ...(error ? { error } : {}) })
  }
  child.once('error', (err) => end(null, err.message))
  child.once('close', (code) => end(code))
  return { ok: true, runId }
}

/** Stops a run this process started. A run that already ended is not an error. */
export function cancelFleetRun(runId: string): boolean {
  const child = running.get(runId)
  if (!child) return false
  log('fleet run cancel requested', { run_id: runId, pid: child.pid ?? 0 })
  child.kill()
  return true
}
