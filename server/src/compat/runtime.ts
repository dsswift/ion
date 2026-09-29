/**
 * compat/runtime — what this running server and its engine speak, read live:
 * the server's Format Versions, the running engine's (from its `health`), the
 * engine's version against `server.json`'s `engine.minVersion`, the app that
 * hosts this server, and how many conversations have an agent running now.
 *
 * `GET /versionz` and `environment.server.info` both read it. The engine is
 * passed in, so this module never imports the server's state.
 */
import type { FormatVersion, HostApp, ServerVersionReport } from '@ion/shared/format-versions'
import { meetsMinVersion } from '../engine/version-check'
import { log as _log, warn as _warn } from '../logger'
import { serverFormats } from './registry'

const TAG = 'compat'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** The slice of the engine bridge this module needs. */
export interface EngineRequester {
  request<T>(cmd: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: T }>
}

interface EngineHealth {
  version?: string
  compat?: FormatVersion[]
}

interface EngineSession {
  hasActiveRun?: boolean
}

export interface EngineRuntime {
  version: string | null
  formats: FormatVersion[]
  /** Engine sessions with an agent running now; null when the engine did not answer. */
  runningConversations: number | null
}

const context = { serverVersion: '0.0.0', engineMinVersion: '0.0.0' }

/** Set once at boot, from the booted server version and `server.json`. */
export function setCompatContext(next: { serverVersion: string; engineMinVersion: string }): void {
  context.serverVersion = next.serverVersion
  context.engineMinVersion = next.engineMinVersion
}

/** The engine minimum the version report and server info judge against. */
export function engineMinVersion(): string {
  return context.engineMinVersion
}

/** The desktop passes its version to the server it runs as `ION_HOST_APP_VERSION`. */
export function hostApp(env: NodeJS.ProcessEnv = process.env): HostApp | null {
  const version = env.ION_HOST_APP_VERSION?.trim()
  return version ? { name: 'desktop', version } : null
}

/** One `health` and one `list_sessions`, in parallel. A failure leaves its half null or empty and is logged. */
export async function readEngineRuntime(engine: EngineRequester): Promise<EngineRuntime> {
  const [health, sessions] = await Promise.all([
    engine.request<EngineHealth>('health').catch((err: unknown) => ({ ok: false, error: String(err), data: undefined })),
    engine.request<EngineSession[]>('list_sessions').catch((err: unknown) => ({ ok: false, error: String(err), data: undefined })),
  ])
  if (!health.ok || !health.data) warn('engine health unavailable for the version report', { error: health.error ?? 'no data' })
  if (!sessions.ok || !Array.isArray(sessions.data)) warn('engine session list unavailable for the version report', { error: sessions.error ?? 'no data' })
  const running = Array.isArray(sessions.data) ? sessions.data.filter((s) => s.hasActiveRun === true).length : null
  return {
    version: health.ok && typeof health.data?.version === 'string' ? health.data.version : null,
    formats: health.ok && Array.isArray(health.data?.compat) ? health.data.compat : [],
    runningConversations: sessions.ok ? running : null,
  }
}

/** The body of `GET /versionz`. */
export async function buildVersionReport(engine: EngineRequester, env: NodeJS.ProcessEnv = process.env): Promise<ServerVersionReport> {
  const runtime = await readEngineRuntime(engine)
  const report: ServerVersionReport = {
    serverVersion: context.serverVersion,
    engineVersion: runtime.version,
    engineMinVersion: context.engineMinVersion,
    engineMeetsMin: runtime.version === null ? null : meetsMinVersion(runtime.version, context.engineMinVersion),
    hostApp: hostApp(env),
    formats: [...serverFormats(), ...runtime.formats],
  }
  log('version report built', { server_version: report.serverVersion, engine_version: report.engineVersion ?? 'unreachable', engine_meets_min: report.engineMeetsMin, format_count: report.formats.length })
  return report
}
