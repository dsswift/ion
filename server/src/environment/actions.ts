/**
 * environment/actions — the `environment.*` `studio_action`s behind the
 * Environment page (ADR-033): projects, folder browsing, git access,
 * host and server facts, background jobs, and purge. One registry in the
 * same shape as `AUTH_ACTIONS`/`TRANSFER_ACTIONS`; `protocol/actions.ts`
 * consults it after those.
 *
 * Scopes: reading facts needs `conversations:read`; changing the host's
 * projects or git identity needs `git:write`; restarting, updating,
 * installing a sent build, log access, and purging need `admin`, because
 * they act on the server itself.
 */
import { createHash } from 'crypto'
import { createReadStream, rmSync } from 'fs'
import { join } from 'path'
import type { Scope } from '@ion/shared/studio-wire/types'
import type { EnvironmentPurgeLevels } from '@ion/shared/types-environment-admin'
import type { EnvironmentSystemMetricsLatest } from '@ion/shared/types-system-metrics'
import type { Connection } from '../protocol/connection'
import { listProjects, addProject, removeProject, appraiseRemoval, relocateProject, startSetup, trustProject, ProjectUntrustedError } from './projects'
import { browseDirectory } from './fs-browse'
import { probeToolchains, tailLog } from './host-info'
import { hostInstallArtifactDir, noteExternalHostInstall, publishHostInstallProgress, requestHostInstall, serverInfoWithInstall } from './host-install'
import { registerInboundTransfer } from '../transfer/inbound-transfer'
import { connectionOnHost } from '../protocol/hello'
import type { HostInstallProgress, HostInstallRequest } from '@ion/shared/host-install'
import { readEngineRuntime } from '../compat/runtime'
import { engineBridge } from '../state'
import { testRemote, readAuthor, writeAuthor } from './git-access'
import { startClone } from './clone'
import { chooseCloneUrl } from './clone-url'
import { listJobs, cancelJob } from './jobs'
import { appraisePurge, runPurge } from './purge'
import { discovery } from '../discovery/runtime'
import { systemMetricsPublisher } from '../system-metrics/runtime'
import { telemetryHealthState } from '../engine/telemetry-health'
import { HISTORY_WINDOW_MS } from '../system-metrics/store'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.actions'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export type EnvironmentActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; refusal?: { code: string; message: string } }
  | { ok: false; error: { code: string; message: string } }

export interface EnvironmentActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<EnvironmentActionOutcome>
}

function firstArgObject(args: unknown[]): Record<string, unknown> {
  const a = args[0]
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
}
function str(a: Record<string, unknown>, key: string): string {
  const v = a[key]
  return typeof v === 'string' ? v : ''
}
function bool(a: Record<string, unknown>, key: string): boolean {
  return a[key] === true
}
function invalid(message: string): EnvironmentActionOutcome {
  return { ok: false, error: { code: 'invalid_args', message } }
}
function failed(code: string, err: unknown): EnvironmentActionOutcome {
  return { ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } }
}

const REPORT_STAGES: ReadonlyArray<HostInstallProgress['stage']> = ['refused', 'downloading', 'installing', 'restarting', 'failed']
function isReportStage(v: string): v is HostInstallProgress['stage'] { return (REPORT_STAGES as readonly string[]).includes(v) }
function isRequestKind(v: string): v is HostInstallRequest['kind'] { return v === 'restart' || v === 'release' || v === 'artifact' }

/** The server version the listener was booted with; set once by `main.ts`. */
let bootedServerVersion = '0.0.0'
export function setEnvironmentServerVersion(v: string): void { bootedServerVersion = v }
export function bootedEnvironmentServerVersion(): string { return bootedServerVersion }

/** Where a build a client sends lands before the host installs it. */
function incomingArtifactPath(transferId: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'artifact'
  return join(hostInstallArtifactDir(), `${transferId.replace(/[^A-Za-z0-9-]/g, '')}-${safe}`)
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

/**
 * `environment.server.installArtifact`: receives a build as `FILE_CHUNK`
 * frames keyed by `transferId`, checks it against the SHA-256 the request
 * named, and has the host install it. Registered before the first `await`,
 * so a chunk on the very next frame finds its transfer.
 */
async function installArtifact(conn: Connection, args: unknown[]): Promise<EnvironmentActionOutcome> {
  const a = firstArgObject(args)
  const transferId = str(a, 'transferId')
  const sha256 = str(a, 'sha256').toLowerCase()
  const totalBytes = typeof a.totalBytes === 'number' && Number.isFinite(a.totalBytes) ? a.totalBytes : 0
  if (!transferId || totalBytes <= 0 || !/^[0-9a-f]{64}$/.test(sha256)) return invalid('transferId, a positive totalBytes, and a sha256 are required')
  const dest = incomingArtifactPath(transferId, str(a, 'name'))
  let received: string
  try {
    received = await registerInboundTransfer(transferId, dest, totalBytes, conn.id)
  } catch (err) {
    warn('artifact transfer aborted before completion', { transfer_id: transferId, error: String(err) })
    rmSync(dest, { force: true })
    return failed('transfer_aborted', err)
  }
  const actual = await sha256File(received)
  if (actual !== sha256) {
    rmSync(received, { force: true })
    warn('artifact refused: checksum mismatch', { transfer_id: transferId, expected: sha256, actual })
    publishHostInstallProgress({ stage: 'refused', kind: 'artifact', code: 'checksum_mismatch', message: 'the build that arrived is not the build that was sent' })
    return { ok: false, refusal: { code: 'checksum_mismatch', message: 'the build that arrived is not the build that was sent; nothing was installed' } }
  }
  log('artifact received and verified', { transfer_id: transferId, bytes: totalBytes, path: received })
  const outcome = requestHostInstall({ kind: 'artifact', path: received })
  // A build the host will not install has nobody left to read it.
  if (!outcome.ok) rmSync(received, { force: true })
  return outcome
}

export const ENVIRONMENT_ACTIONS: Record<string, EnvironmentActionSpec> = {
  'environment.projects.list': {
    requiredScope: 'conversations:read',
    handler: async () => ({ ok: true, value: await listProjects() }),
  },
  'environment.projects.add': {
    requiredScope: 'git:write',
    handler: async (_conn, args) => {
      const a = firstArgObject(args)
      const dir = str(a, 'dir')
      if (!dir) return invalid('dir is required')
      try {
        return { ok: true, value: await addProject(dir, { name: str(a, 'name') || undefined }) }
      } catch (err) { return failed('add_failed', err) }
    },
  },
  'environment.projects.appraiseRemoval': {
    requiredScope: 'conversations:read',
    handler: async (_conn, args) => {
      const dir = str(firstArgObject(args), 'dir')
      if (!dir) return invalid('dir is required')
      return { ok: true, value: await appraiseRemoval(dir) }
    },
  },
  'environment.projects.remove': {
    requiredScope: 'git:write',
    handler: async (_conn, args) => {
      const a = firstArgObject(args)
      const dir = str(a, 'dir')
      if (!dir) return invalid('dir is required')
      try {
        return { ok: true, value: await removeProject(dir, { deleteFiles: bool(a, 'deleteFiles'), force: bool(a, 'force') }) }
      } catch (err) { return { ok: false, refusal: { code: 'remove_refused', message: err instanceof Error ? err.message : String(err) } } }
    },
  },
  'environment.projects.relocate': {
    requiredScope: 'git:write',
    handler: async (_conn, args) => {
      const a = firstArgObject(args)
      const from = str(a, 'from')
      const to = str(a, 'to')
      if (!from || !to) return invalid('from and to are required')
      try {
        return { ok: true, value: await relocateProject(from, to) }
      } catch (err) { return { ok: false, refusal: { code: 'relocate_refused', message: err instanceof Error ? err.message : String(err) } } }
    },
  },
  'environment.projects.setup': {
    requiredScope: 'git:write',
    handler: async (_conn, args) => {
      const dir = str(firstArgObject(args), 'dir')
      if (!dir) return invalid('dir is required')
      try { return { ok: true, value: startSetup(dir) } } catch (err) {
        if (err instanceof ProjectUntrustedError) return { ok: false, refusal: { code: err.code, message: err.message } }
        return failed('setup_failed', err)
      }
    },
  },
  'environment.projects.trust': {
    requiredScope: 'git:write',
    handler: async (_conn, args) => {
      const dir = str(firstArgObject(args), 'dir')
      if (!dir) return invalid('dir is required')
      try { return { ok: true, value: await trustProject(dir) } } catch (err) { return { ok: false, refusal: { code: 'trust_refused', message: err instanceof Error ? err.message : String(err) } } }
    },
  },
  'environment.projects.clone': {
    requiredScope: 'git:write',
    handler: async (conn, args) => {
      const a = firstArgObject(args)
      const parentDir = str(a, 'parentDir')
      // Either one URL, or a repository's SSH and HTTPS pair for this host to pick from.
      const remote = firstArgObject([a.remote])
      const pair = { sshUrl: str(remote, 'sshUrl'), httpsUrl: str(remote, 'httpsUrl') }
      const url = pair.sshUrl && pair.httpsUrl ? await chooseCloneUrl(conn.principal?.subject, pair) : str(a, 'url')
      if (!url || !parentDir) return invalid('url (or remote.sshUrl and remote.httpsUrl) and parentDir are required')
      try {
        return { ok: true, value: await startClone({ url, parentDir, name: str(a, 'name') || undefined, trust: a.trust === true }) }
      } catch (err) { return { ok: false, refusal: { code: 'clone_refused', message: err instanceof Error ? err.message : String(err) } } }
    },
  },
  'environment.jobs.list': {
    requiredScope: 'conversations:read',
    handler: async () => ({ ok: true, value: listJobs() }),
  },
  'environment.jobs.cancel': {
    requiredScope: 'git:write',
    handler: async (_conn, args) => {
      const id = str(firstArgObject(args), 'jobId')
      if (!id) return invalid('jobId is required')
      return { ok: true, value: { cancelled: cancelJob(id) } }
    },
  },
  'environment.fs.browse': {
    requiredScope: 'conversations:read',
    handler: async (_conn, args) => {
      const a = firstArgObject(args)
      try { return { ok: true, value: browseDirectory(str(a, 'path') || '~', bool(a, 'showHidden')) } } catch (err) { return failed('browse_failed', err) }
    },
  },
  'environment.host.toolchains': {
    requiredScope: 'conversations:read',
    handler: async () => ({ ok: true, value: await probeToolchains() }),
  },
  'environment.server.info': {
    requiredScope: 'conversations:read',
    handler: async () => ({ ok: true, value: serverInfoWithInstall(bootedServerVersion, await readEngineRuntime(engineBridge)) }),
  },
  // System Metrics: `watch` starts or stops this connection's live samples
  // (`ion:system-metrics`, or `desktop_system_metrics` for a thin client) and
  // returns the latest; `latest` returns the newest full sample and telemetry
  // delivery health without touching any watch; `history` returns the
  // bucketed last `windowSec`.
  'environment.systemMetrics.watch': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      const publisher = systemMetricsPublisher()
      if (!publisher) return { ok: false, refusal: { code: 'unavailable', message: 'system metrics are not available on this server' } }
      const on = bool(firstArgObject(args), 'on')
      return { ok: true, value: { latest: publisher.watch(conn, on), watching: on } }
    },
  },
  'environment.systemMetrics.latest': {
    requiredScope: 'conversations:read',
    handler: async () => {
      const publisher = systemMetricsPublisher()
      const value: EnvironmentSystemMetricsLatest = { latest: publisher?.latest() ?? null, telemetryHealth: telemetryHealthState() }
      log('system metrics latest read', { has_publisher: publisher !== null, has_sample: value.latest !== null, telemetry_targets: value.telemetryHealth.length })
      return { ok: true, value }
    },
  },
  'environment.systemMetrics.history': {
    requiredScope: 'conversations:read',
    handler: async (_conn, args) => {
      const publisher = systemMetricsPublisher()
      if (!publisher) return { ok: false, refusal: { code: 'unavailable', message: 'system metrics are not available on this server' } }
      const a = firstArgObject(args)
      const windowSec = typeof a.windowSec === 'number' && Number.isFinite(a.windowSec) ? a.windowSec : 900
      const windowMs = Math.min(Math.max(windowSec * 1000, 0), HISTORY_WINDOW_MS)
      return { ok: true, value: { buckets: publisher.store.history(windowMs), windowMs } }
    },
  },
  'environment.server.logTail': {
    requiredScope: 'admin',
    handler: async (_conn, args) => {
      const a = firstArgObject(args)
      const file = str(a, 'file')
      if (file !== 'engine' && file !== 'server') return invalid('file must be engine or server')
      const lines = typeof a.lines === 'number' && Number.isFinite(a.lines) ? Math.floor(a.lines) : 200
      try { return { ok: true, value: tailLog(file, lines) } } catch (err) { return failed('log_read_failed', err) }
    },
  },
  // The host installs on itself (`host-install.ts`): a bundle server runs
  // its own `ion studio` command, a desktop-run server asks its desktop.
  'environment.server.restart': {
    requiredScope: 'admin',
    handler: async () => requestHostInstall({ kind: 'restart' }),
  },
  'environment.server.update': {
    requiredScope: 'admin',
    handler: async (_conn, args) => requestHostInstall({ kind: 'release', version: str(firstArgObject(args), 'version') || undefined }),
  },
  'environment.server.installArtifact': {
    requiredScope: 'admin',
    handler: installArtifact,
  },
  // The desktop that runs this server says how a host install it was handed
  // is going. Only that desktop may: it is the connection on the host.
  'environment.server.reportInstall': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      if (!connectionOnHost(conn)) return { ok: false, refusal: { code: 'not_on_host', message: 'only the desktop that runs this server reports its installs' } }
      const a = firstArgObject(args)
      const stage = str(a, 'stage')
      const kind = str(a, 'kind')
      if (!isReportStage(stage) || !isRequestKind(kind)) return invalid('stage and kind are required')
      publishHostInstallProgress({ stage, kind, code: str(a, 'code') || undefined, message: str(a, 'message') || undefined })
      return { ok: true, value: null }
    },
  },
  // A fleet deploy says it is about to install on this host over SSH, which
  // this server takes no part in.
  'environment.server.installNotice': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      log('host install notice received', { connection_id: conn.id, deploy_id: str(firstArgObject(args), 'deployId') })
      noteExternalHostInstall()
      return { ok: true, value: null }
    },
  },
  'environment.git.test': {
    requiredScope: 'git:write',
    handler: async (_conn, args) => {
      const url = str(firstArgObject(args), 'url')
      if (!url) return invalid('url is required')
      return { ok: true, value: await testRemote(url) }
    },
  },
  'environment.git.author.get': {
    requiredScope: 'conversations:read',
    handler: async () => ({ ok: true, value: await readAuthor() }),
  },
  'environment.git.author.set': {
    requiredScope: 'git:write',
    handler: async (_conn, args) => {
      const a = firstArgObject(args)
      try { return { ok: true, value: await writeAuthor({ name: str(a, 'name'), email: str(a, 'email') }) } } catch (err) { return invalid(err instanceof Error ? err.message : String(err)) }
    },
  },
  'environment.purge.appraise': {
    requiredScope: 'admin',
    handler: async (conn) => ({ ok: true, value: await appraisePurge(conn.principal?.subject) }),
  },
  'environment.purge.run': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      const a = firstArgObject(args)
      const levels: EnvironmentPurgeLevels = { studio: true, gitCredentials: bool(a, 'gitCredentials'), clones: bool(a, 'clones'), data: bool(a, 'data'), force: bool(a, 'force') }
      try { return { ok: true, value: await runPurge(levels, conn.principal?.subject) } } catch (err) { return failed('purge_failed', err) }
    },
  },
  // ── LAN discovery (discovery/window.ts) ─────────────────────────────────
  // Status is for anyone who can see the environment (the door needs to know
  // it is sealed); the code inside it, and every verb, is admin's.
  'environment.discovery.status': {
    requiredScope: 'conversations:read',
    handler: async (conn) => {
      const window = discovery()
      if (!window) return { ok: false, error: { code: 'not_ready', message: 'discovery is not running yet' } }
      const status = window.status()
      return { ok: true, value: conn.scopes.includes('admin') ? status : { ...status, code: null } }
    },
  },
  'environment.discovery.open': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      const window = discovery()
      if (!window) return { ok: false, error: { code: 'not_ready', message: 'discovery is not running yet' } }
      const minutes = Number(firstArgObject(args).minutes)
      const result = window.open({ subject: conn.principal?.subject ?? 'unknown', scopes: conn.scopes }, minutes)
      if (!result.ok) return { ok: false, refusal: result.refusal }
      log('discovery window opened', { subject: conn.principal?.subject, minutes })
      return { ok: true, value: result.status }
    },
  },
  'environment.discovery.close': {
    requiredScope: 'admin',
    handler: async (conn) => {
      const window = discovery()
      if (!window) return { ok: false, error: { code: 'not_ready', message: 'discovery is not running yet' } }
      log('discovery window closed on request', { subject: conn.principal?.subject })
      return { ok: true, value: window.close() }
    },
  },
  'environment.discovery.mintCode': {
    requiredScope: 'admin',
    handler: async (conn) => {
      const window = discovery()
      if (!window) return { ok: false, error: { code: 'not_ready', message: 'discovery is not running yet' } }
      const result = window.mintCode({ subject: conn.principal?.subject ?? 'unknown', scopes: conn.scopes })
      if (!result.ok) return { ok: false, refusal: result.refusal }
      log('discovery code minted on request', { subject: conn.principal?.subject, expires_at: result.expiresAt })
      return { ok: true, value: { code: result.code, expiresAt: result.expiresAt } }
    },
  },
}
