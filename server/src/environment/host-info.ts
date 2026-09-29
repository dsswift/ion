/**
 * environment/host-info — what the Environment page's Server section shows
 * about THIS server's host: installed toolchains, the server/engine/bundle
 * versions, and the tail of the two log files, all read locally and served
 * over the studio wire.
 */
import { execFile } from 'child_process'
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'fs'
import { homedir, hostname } from 'os'
import { join } from 'path'
import type { EnvironmentServerInfo, EnvironmentToolchains, EnvironmentLogFile } from '@ion/shared/types-environment-admin'
import { dataDir } from '../paths'
import { peekEngineHostInfo } from '../engine/engine-bridge-fs'
import { meetsMinVersion } from '../engine/version-check'
import { engineMinVersion, hostApp, type EngineRuntime } from '../compat/runtime'
import { serverFormats } from '../compat/registry'
import { getCliPath } from '../cli-env'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.host-info'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

const TOOLS: Array<{ name: EnvironmentToolchains['tools'][number]['name']; versionArgs: string[] }> = [
  { name: 'git', versionArgs: ['--version'] },
  { name: 'go', versionArgs: ['version'] },
  { name: 'node', versionArgs: ['--version'] },
  { name: 'npm', versionArgs: ['--version'] },
  { name: 'gh', versionArgs: ['--version'] },
]

function run(file: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env: { ...process.env, PATH: getCliPath() } }, (err, stdout) => {
      if (err) resolve({ ok: false, stdout: String(stdout ?? ''), error: err.message })
      else resolve({ ok: true, stdout: String(stdout) })
    })
  })
}

/**
 * True when `path` is inside the Studio Server bundle: the `node` the
 * bundle ships is the server's own runtime, on this process's PATH so the
 * service can start, and not a developer tool the host has. A project setup
 * that runs `npm` or `node` finds neither on the host's login shell, so
 * reporting the bundled copy as present would promise a toolchain the setup
 * then fails to find.
 */
export function isBundledTool(path: string, bundleRoot: string | null = studioBundleRoot()): boolean {
  return bundleRoot !== null && path.startsWith(bundleRoot + '/')
}

/** Where each tool resolves on the operator's login-shell PATH, with its version line. A copy inside the server's own bundle does not count. */
export async function probeToolchains(): Promise<EnvironmentToolchains> {
  const tools: EnvironmentToolchains['tools'] = []
  const bundleRoot = studioBundleRoot()
  for (const tool of TOOLS) {
    const which = await run(process.platform === 'win32' ? 'where' : 'which', [tool.name])
    let path = which.ok ? which.stdout.trim().split('\n').find((p) => p && !isBundledTool(p, bundleRoot)) ?? null : null
    if (which.ok && !path) {
      log('tool resolves only inside the server bundle; reported missing', { tool: tool.name, bundled_path: which.stdout.trim().split('\n')[0] ?? '' })
      path = null
    }
    let version: string | null = null
    if (path) {
      const v = await run(path, tool.versionArgs)
      version = v.ok ? v.stdout.trim().split('\n')[0] ?? null : null
    }
    tools.push({ name: tool.name, path: path || null, version })
  }
  log('toolchains probed', { present: tools.filter((t) => t.path).map((t) => t.name), missing: tools.filter((t) => !t.path).map((t) => t.name) })
  return { tools }
}

/** The bundle root a `ion studio install` leaves under the data dir; null when this server was not installed that way. */
export function studioBundleRoot(): string | null {
  const root = join(dataDir(), 'studio-server')
  return existsSync(join(root, 'current', 'VERSION')) ? root : null
}

export function readBundleVersion(root: string): { server: string; engine: string; node: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'current', 'VERSION'), 'utf-8')) as Partial<Record<'server' | 'engine' | 'node', unknown>>
    return { server: String(parsed.server ?? ''), engine: String(parsed.engine ?? ''), node: String(parsed.node ?? '') }
  } catch (err) {
    warn('bundle VERSION unreadable', { root, error: String(err) })
    return null
  }
}

/** What the Server section shows, with the engine's live half (`readEngineRuntime`) passed in. */
export function serverInfo(serverVersion: string, runtime: EngineRuntime): EnvironmentServerInfo {
  const engine = peekEngineHostInfo()
  const root = studioBundleRoot()
  const version = root ? readBundleVersion(root) : null
  const engineVersion = runtime.version ?? engine?.version ?? null
  const minVersion = engineMinVersion()
  return {
    serverVersion,
    engineVersion,
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    dataDir: dataDir(),
    bundle: root && version ? { root, version } : null,
    uptimeSeconds: Math.round(process.uptime()),
    engineMinVersion: minVersion,
    engineMeetsMin: engineVersion === null ? null : meetsMinVersion(engineVersion, minVersion),
    hostApp: hostApp(),
    runningConversations: runtime.runningConversations,
    formats: [...serverFormats(), ...runtime.formats],
  }
}

const TAIL_READ_BYTES = 512 * 1024

/** The last `lines` lines of a log file, read from its tail without loading the whole file. */
export function tailLog(file: EnvironmentLogFile, lines: number): { path: string; lines: string[] } {
  const path = join(dataDir(), file === 'engine' ? 'engine.jsonl' : 'server.jsonl')
  if (!existsSync(path)) {
    log('log tail: file absent', { path })
    return { path, lines: [] }
  }
  const size = statSync(path).size
  const start = Math.max(0, size - TAIL_READ_BYTES)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const all = buf.toString('utf-8').split('\n').filter((l) => l.length > 0)
    const out = all.slice(-Math.max(1, Math.min(lines, 2000)))
    log('log tail read', { path, requested: lines, returned: out.length })
    return { path, lines: out }
  } finally {
    closeSync(fd)
  }
}
