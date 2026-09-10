/**
 * Resolves the engine's listen address the same way the engine itself does
 * (engine/cmd/ion/paths.go), so the desktop connects to whatever the engine
 * actually bound: a unix socket everywhere except win32, where the engine
 * has no unix-socket support and listens on loopback TCP instead.
 *
 * Manifest contract C1 (windows-mvp program). This module is the single
 * source of truth for address resolution; engine-bootstrap.ts and the two
 * engine-bridge-*.ts siblings all resolve through it rather than hardcoding
 * '.ion/engine.sock'.
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { createConnection, Socket } from 'net'
import { homedir } from 'os'
// This module's non-win32 branch (below) always builds a POSIX path — it
// describes where the ENGINE (darwin/linux only, never win32) binds its unix
// socket, a target-platform fact independent of whatever OS is running this
// code right now. `resolveEngineAddress` accepts an explicit `platform`
// parameter precisely so callers (and this file's own tests) can ask "what
// would a darwin engine use" while running on Windows. The platform-native
// `join` would answer that question with backslashes on a Windows dev/CI
// machine, which is simply wrong for a path the darwin/linux engine will
// read. `path/posix` keeps the answer correct regardless of the host OS.
import { join } from 'path/posix'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('engine-address', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('engine-address', msg, fields) }

export type EngineAddress =
  | { kind: 'unix'; path: string }
  | { kind: 'tcp'; host: string; port: number }
  // No address exists for this user. Only reachable on Windows, when the
  // user's SID cannot be read and therefore no per-user port can be derived.
  // A typed value rather than a thrown error because this module is imported
  // at load time by the bridge: a throw would take down the main process
  // before any logger or dialog exists, and the operator would see nothing.
  // Every consumer handles this case explicitly and says so.
  | { kind: 'unavailable'; reason: string }

// Must match engine/cmd/ion/port_windows.go. The two derive the address
// independently rather than one telling the other, so any divergence here is
// a desktop that cannot find its own engine -- which is why both sides are
// pinned by tests against the same SID vectors.
const PORT_RANGE_START = 51000
const PORT_RANGE_SIZE = 4000

let cachedPort: number | null = null

/**
 * The current user's SID, or null when it cannot be read.
 *
 * whoami.exe is used rather than a native binding because the desktop already
 * shells out to it for the Scheduled Task principal, and this runs once per
 * process.
 */
export function currentUserSid(): string | null {
  try {
    const out = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })
    return /S-1-[\d-]+/.exec(out)?.[0] ?? null
  } catch (err) {
    warn('could not read the current user SID', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * The loopback port for this user's engine on Windows, derived from their
 * SID exactly as the engine derives it, or a reason it could not be.
 *
 * A single fixed port is safe for one interactive user and wrong the moment
 * there are two. On a shared workstation with fast user switching, or on an
 * Azure Virtual Desktop multi-session host, the second user's engine cannot
 * bind the port and their desktop connects to the FIRST user's engine.
 *
 * There is no fallback port. There used to be: an unreadable SID resolved to
 * 21017, and two users whose lookups both failed landed on the SAME address --
 * the exact collision the per-user derivation exists to prevent, reached by
 * the failure path. Returning a reason instead means the desktop reports that
 * it cannot find its own engine, which an operator can act on, rather than
 * silently attaching to somebody else's.
 *
 * Note what this does and does not buy. A per-user port stops two engines
 * colliding; it does NOT stop another signed-in user from scanning
 * 51000-54999 and connecting to the port they find. Authorization is the
 * engine's, in engine/internal/server/peerauth_windows.go, which checks each
 * peer's process token against its own user.
 *
 * Cached: the SID cannot change within a process, and this is consulted on
 * every reconnect probe.
 */
export function userScopedPort(): { port: number } | { reason: string } {
  if (cachedPort !== null) return { port: cachedPort }
  const sid = currentUserSid()
  if (!sid) {
    const reason = 'could not read this user\'s Windows SID, so no per-user engine port can be derived'
    warn('no engine address for this user; refusing to fall back to a shared port', { reason })
    return { reason }
  }
  const digest = createHash('sha256').update(sid).digest()
  cachedPort = PORT_RANGE_START + (digest.readUInt32BE(0) % PORT_RANGE_SIZE)
  log('resolved the per-user engine port', { port: cachedPort })
  return { port: cachedPort }
}

/** Test seam: clears the memoised port so a test can vary the SID. */
export function _resetPortCacheForTest(): void {
  cachedPort = null
}

// A drive letter ("C:\" or "C:/") is not a host:port pair even though it
// contains a colon — this is what makes ION_SOCKET_PATH's dual path/address
// meaning unambiguous on Windows.
const DRIVE_RE = /^[A-Za-z]:[\\/]/

/**
 * Reports whether v parses as "host:port" per the engine's own
 * looksLikeHostPort (engine/cmd/ion/paths.go): contains a colon, and does
 * not look like a path (leading '/', './', or a Windows drive letter).
 */
export function looksLikeHostPort(v: string): boolean {
  // posix-ok: this rejects paths to identify a host:port, and the Windows
  // path form is already covered by DRIVE_RE on the same line.
  return v.includes(':') && !v.startsWith('/') && !v.startsWith('.') && !DRIVE_RE.test(v)
}

/**
 * Resolves the engine's address exactly as engine/cmd/ion/paths.go does:
 *
 *  1. ION_SOCKET_PATH, if set — host:port when looksLikeHostPort, else a
 *     unix socket path.
 *  2. On win32: TCP on 127.0.0.1, at a port derived from the user's SID (the
 *     engine has no unix-socket support there, and a fixed port would
 *     cross-wire two users signed in to the same machine).
 *  3. Elsewhere: a unix socket at <dataDir>/engine.sock, where dataDir is
 *     ION_DATA_DIR or ~/.ion.
 */
export function resolveEngineAddress(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): EngineAddress {
  const override = env.ION_SOCKET_PATH
  if (override) {
    if (looksLikeHostPort(override)) {
      const i = override.lastIndexOf(':')
      return { kind: 'tcp', host: override.slice(0, i), port: Number(override.slice(i + 1)) }
    }
    return { kind: 'unix', path: override }
  }
  if (platform === 'win32') {
    const p = userScopedPort()
    if ('reason' in p) return { kind: 'unavailable', reason: p.reason }
    return { kind: 'tcp', host: '127.0.0.1', port: p.port }
  }
  const dataDir = env.ION_DATA_DIR || join(home, '.ion')
  return { kind: 'unix', path: join(dataDir, 'engine.sock') }
}

/**
 * Renders an address for logs and error messages:
 * "unix:<path>" | "tcp:<host>:<port>" | "unavailable:<reason>".
 */
export function describeEngineAddress(addr: EngineAddress): string {
  if (addr.kind === 'unix') return `unix:${addr.path}`
  if (addr.kind === 'tcp') return `tcp:${addr.host}:${addr.port}`
  return `unavailable:${addr.reason}`
}

/**
 * Opens a socket to addr — a unix-domain connection or a TCP connection.
 *
 * An unavailable address throws rather than picking one. Every caller already
 * handles a connect failure, and there is no address here that would be
 * anything other than a guess at somebody else's engine.
 */
export function connectToEngine(addr: EngineAddress): Socket {
  if (addr.kind === 'unavailable') {
    throw new Error(`No Ion Engine address for this user: ${addr.reason}. Set ION_SOCKET_PATH to name one explicitly.`)
  }
  return addr.kind === 'unix' ? createConnection(addr.path) : createConnection({ host: addr.host, port: addr.port })
}

/**
 * One connect probe: resolves true on 'connect', false on 'error'. Shared by
 * the bootstrap readiness wait and the bridge's shutdown wait — both need
 * "can I reach the engine right now", which is the same question for either
 * address kind (a unix socket file existing proves nothing on its own, and
 * there is no file to check at all for TCP).
 */
export function probeEngine(addr: EngineAddress): Promise<boolean> {
  return new Promise((resolve) => {
    if (addr.kind === 'unavailable') {
      // Not reachable, and never will be until the address resolves. Reported
      // as "no" so readiness waits terminate on their own budget instead of
      // throwing out of a poll loop.
      resolve(false)
      return
    }
    const conn = connectToEngine(addr)
    conn.once('connect', () => {
      conn.destroy()
      resolve(true)
    })
    conn.once('error', () => {
      conn.destroy()
      resolve(false)
    })
  })
}

/**
 * Names the platform-appropriate command an operator runs to check supervisor
 * status.
 *
 * A hint has one job: the operator pastes it and it runs. So every command
 * here is one that actually works.
 *
 * On Windows the task is named per user -- "Ion Engine (<SID>)", see
 * engine-supervisor-schtasks.ts -- so the hint has to name THIS user's task.
 * `schtasks /TN` takes an exact task name and nothing else: it has no wildcard
 * syntax, and a `/TN "Ion Engine (*"` reads like one while actually failing
 * with "The system cannot find the file specified". When the SID resolves, the
 * exact name is substituted. When it does not -- which is the same condition
 * that leaves the address unavailable -- schtasks cannot be used at all, so
 * the fallback is a PowerShell enumeration that really does match a prefix.
 *
 * @param sid Overrides SID resolution. Passed by tests, and by any caller that
 *   already resolved it; omitted in production, where it is read here.
 */
export function supervisorHint(
  platform: NodeJS.Platform = process.platform,
  sid: string | null = platform === 'win32' && process.platform === 'win32' ? currentUserSid() : null,
): string {
  if (platform === 'darwin') return 'launchctl print gui/$UID/com.ion.engine'
  if (platform === 'win32') {
    if (sid) return `schtasks /Query /TN "Ion Engine (${sid})" /V /FO LIST`
    return 'powershell -NoProfile -Command "Get-ScheduledTask | Where-Object TaskName -like \'Ion Engine*\' | Format-List TaskName, State"'
  }
  return 'ion status'
}
