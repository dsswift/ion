/**
 * environment/host-install — the host installs on itself: a restart, a
 * release, or a build a client sent (`@ion/shared/host-install`).
 *
 * A Studio Server bundle runs its own `ion studio restart | update`, spawned
 * detached because the command stops this very process. A server a desktop
 * runs hands the request to that desktop over its on-host connection. A
 * server that is neither refuses, and says why.
 */
import { spawn, spawnSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import {
  HOST_INSTALL_CAPABILITY, HOST_INSTALL_PROGRESS_CHANNEL, HOST_INSTALL_REFUSALS, HOST_INSTALL_REQUESTED_CHANNEL,
  type HostInstallProgress, type HostInstallRefusal, type HostInstallRequest,
} from '@ion/shared/host-install'
import { connectionRegistry, type Connection } from '../protocol/connection'
import { connectionOnHost } from '../protocol/hello'
import { broadcast } from '../broadcast'
import { hostApp, type EngineRuntime } from '../compat/runtime'
import type { EnvironmentServerInfo } from '@ion/shared/types-environment-admin'
import { dataDir } from '../paths'
import { serverInfo, studioBundleRoot } from './host-info'
import { clearHostInstallMarker, readHostInstallMarker, writeHostInstallMarker } from './host-install-marker'
import { fleetHubLinks } from '../fleet/hub-links'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.host-install'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export type HostInstallOutcome =
  | { ok: true; value: { scheduled: true; by: 'bundle' | 'desktop' } }
  | { ok: false; refusal: { code: string; message: string } }
  | { ok: false; error: { code: string; message: string } }

function refuse(code: HostInstallRefusal): HostInstallOutcome {
  return { ok: false, refusal: { code, message: HOST_INSTALL_REFUSALS[code] } }
}

/** Where a build a client sends lands before the host installs it. */
export function hostInstallArtifactDir(): string {
  return join(dataDir(), 'host-install')
}

/**
 * Run once at boot: removes every build sent to this host. One that was
 * installed has been read by now, and one that was not will not be.
 */
export function clearHostInstallArtifacts(): void {
  const dir = hostInstallArtifactDir()
  if (!existsSync(dir)) return
  try {
    rmSync(dir, { recursive: true, force: true })
    log('sent builds removed', { path: dir })
  } catch (err) {
    warn('sent builds could not be removed', { path: dir, error: String(err) })
  }
}

/**
 * Publishes one step to every client and to every Fleet Hub this server
 * reports to. A step that ends the install without a restart clears the
 * marker left for the next boot.
 */
export function publishHostInstallProgress(progress: Omit<HostInstallProgress, 'at'>): void {
  const stamped: HostInstallProgress = { ...progress, at: Date.now() }
  log('host install progress', { stage: stamped.stage, kind: stamped.kind, code: stamped.code ?? '', message: stamped.message ?? '' })
  if (stamped.stage === 'refused' || stamped.stage === 'failed') clearHostInstallMarker()
  broadcast(HOST_INSTALL_PROGRESS_CHANNEL, stamped)
  fleetHubLinks()?.install(stamped)
}

/**
 * An install is about to replace this server from outside it: a fleet deploy
 * over SSH, which this server takes no part in. Saying so here is what lets
 * the server report the install, and its own return, to its clients and hubs.
 */
export function noteExternalHostInstall(): void {
  writeHostInstallMarker('artifact')
  publishHostInstallProgress({ stage: 'installing', kind: 'artifact' })
}

/**
 * Run once at boot, after the hub links start: when the last server on this
 * host went down for an install, says the host is back and what it now runs.
 */
export function completePendingHostInstall(serverVersion: string): void {
  const marker = readHostInstallMarker()
  if (!marker) return
  clearHostInstallMarker()
  log('host is back after an install', { kind: marker.kind, server_version: serverVersion, down_ms: Date.now() - marker.at })
  publishHostInstallProgress({ stage: 'completed', kind: marker.kind, version: serverVersion })
}

/** Run as the server stops: a stop during an install is the host going down for it. */
export function announceHostInstallRestart(): void {
  const marker = readHostInstallMarker()
  if (marker) publishHostInstallProgress({ stage: 'restarting', kind: marker.kind })
}

/** Where the bundle's services are installed for the whole system on macOS. */
const SYSTEM_SERVICE_PLIST = '/Library/LaunchDaemons/com.ion.studio-server.plist'

/**
 * Whether restarting the bundle's services needs a sudo password nobody is
 * here to type: they are system services and `sudo -n` is refused.
 */
function restartNeedsSudoPassword(): boolean {
  if (process.platform !== 'darwin' || !existsSync(SYSTEM_SERVICE_PLIST)) return false
  const probe = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' })
  sudoProbe = { needsPassword: probe.status !== 0, at: Date.now() }
  return sudoProbe.needsPassword
}

/**
 * The last sudo probe. Every Fleet Report asks whether the host can install,
 * and each refused `sudo -n` is a line in the host's auth log, so the answer
 * is asked for again only this often. A real install always probes afresh.
 */
const SUDO_PROBE_KEPT_MS = 10 * 60_000
let sudoProbe: { needsPassword: boolean; at: number } | null = null

/** TEST ONLY. */
export function _resetSudoProbeForTest(): void {
  sudoProbe = null
}

function restartNeedsSudoPasswordKept(): boolean {
  if (sudoProbe && Date.now() - sudoProbe.at < SUDO_PROBE_KEPT_MS) return sudoProbe.needsPassword
  return restartNeedsSudoPassword()
}

function studioArgs(request: HostInstallRequest): string[] {
  switch (request.kind) {
    case 'restart': return ['restart']
    case 'release': return ['update', ...(request.version ? [request.version] : []), '--yes']
    case 'artifact': return ['update', '--bundle', request.path, '--yes']
  }
}

function runBundleCommand(root: string, request: HostInstallRequest): HostInstallOutcome {
  if (restartNeedsSudoPassword()) {
    warn('host install refused: system services need a sudo password', { kind: request.kind })
    return refuse('needs_sudo')
  }
  const bin = join(root, 'current', 'bin', 'ion')
  if (!existsSync(bin)) return { ok: false, error: { code: 'bundle_incomplete', message: `${bin} is missing` } }
  const args = ['studio', ...studioArgs(request)]
  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', env: { ...process.env, ION_DATA_DIR: dataDir() } })
    child.unref()
    log('studio command scheduled', { args, pid: child.pid ?? 0 })
    return { ok: true, value: { scheduled: true, by: 'bundle' } }
  } catch (err) {
    warn('studio command could not be scheduled', { args, error: String(err) })
    return { ok: false, error: { code: 'spawn_failed', message: err instanceof Error ? err.message : String(err) } }
  }
}

/** The desktop that runs this server and can install for it: connected on the host, newest first. */
function hostDesktop(): Connection | undefined {
  return connectionRegistry.all()
    .filter((conn) => !conn.isClosed && connectionOnHost(conn) && conn.hasCapability(HOST_INSTALL_CAPABILITY))
    .sort((a, b) => b.connectedAt - a.connectedAt)[0]
}

/**
 * Whether this host could carry out an install right now, by the same rules
 * `requestHostInstall` applies, without starting one. A client reads it to
 * choose between asking the host and deploying over SSH.
 */
export function hostInstallAvailability(): { available: boolean; code?: HostInstallRefusal } {
  if (studioBundleRoot()) return restartNeedsSudoPasswordKept() ? { available: false, code: 'needs_sudo' } : { available: true }
  if (hostApp()) return hostDesktop() ? { available: true } : { available: false, code: 'host_app_unreachable' }
  return { available: false, code: 'no_bundle' }
}

/** `environment.server.info`, with whether the host can install on itself. */
export function serverInfoWithInstall(serverVersion: string, runtime: EngineRuntime): EnvironmentServerInfo {
  return { ...serverInfo(serverVersion, runtime), hostInstall: hostInstallAvailability() }
}

/** Carries out, or hands off, one host install. Answers before the host goes down. */
export function requestHostInstall(request: HostInstallRequest): HostInstallOutcome {
  const root = studioBundleRoot()
  let outcome: HostInstallOutcome
  if (root) {
    outcome = runBundleCommand(root, request)
  } else if (hostApp()) {
    const desktop = hostDesktop()
    if (!desktop) {
      outcome = refuse('host_app_unreachable')
    } else {
      desktop.send({ type: 'studio_event', channel: HOST_INSTALL_REQUESTED_CHANNEL, payload: request })
      log('host install handed to the desktop that runs this server', { kind: request.kind, connection_id: desktop.id })
      outcome = { ok: true, value: { scheduled: true, by: 'desktop' } }
    }
  } else {
    outcome = refuse('no_bundle')
  }
  if (outcome.ok) {
    writeHostInstallMarker(request.kind)
    publishHostInstallProgress({ stage: 'requested', kind: request.kind })
  } else {
    const reason = 'refusal' in outcome ? outcome.refusal : outcome.error
    publishHostInstallProgress({ stage: 'refusal' in outcome ? 'refused' : 'failed', kind: request.kind, code: reason.code, message: reason.message })
  }
  return outcome
}
