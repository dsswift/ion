/**
 * Engine-server spawning helper.
 *
 * Extracted from engine-bridge.ts so that god-file stays under the
 * 600-line cap. The binary-discovery + child-spawn logic is a
 * self-contained subsystem — it has no dependencies on the bridge's
 * connection state and is exercised exactly once per cold start.
 *
 * Discovery order, highest priority first:
 *
 *   1. `process.resourcesPath/engine/ion` — the bundled binary inside a
 *      packaged `.app` (production).
 *   2. `<repo>/engine/bin/ion` — the dev monorepo build output.
 *   3. `~/.ion/bin/ion` — a globally-installed CLI.
 *   4. `which ion` — anywhere on PATH (last-resort).
 *
 * The first match wins. If nothing matches, the spawn throws and the
 * caller surfaces an "engine not found" error to the user. The
 * discovery list is deliberately small — the bridge is the only socket
 * peer the desktop ever talks to, so the path doesn't need to be
 * configurable; it just needs to be findable.
 *
 * macOS TCC note: the child is spawned with `stdio: 'ignore'` and
 * inherits the parent process group/session so file-system access is
 * attributed to Ion.app rather than recording a separate TCC identity
 * for the engine binary. See the inline comment for the long-form
 * rationale.
 */

import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from './logger'
import { getCliEnv } from './cli-env'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Find the ion engine binary and spawn it as a child of Ion.app.
 *
 * @param socketPath  ION_SOCKET_PATH the spawned server will bind to.
 * @param pidPath     ION_PID_PATH the spawned server will write its PID to.
 * @throws when no candidate binary path exists.
 */
export function spawnEngineServer(socketPath: string, pidPath: string): void {
  log('Starting engine server...')

  // Find ion engine binary
  const bundled = process.resourcesPath
    ? join(process.resourcesPath, 'engine', 'ion')
    : null
  const candidates = [
    ...(bundled ? [bundled] : []),                              // packaged .app
    join(__dirname, '..', '..', '..', 'engine', 'bin', 'ion'), // dev monorepo
    join(homedir(), '.ion', 'bin', 'ion'),                      // installed CLI
  ]

  let binary: string | null = null
  for (const c of candidates) {
    if (existsSync(c)) {
      binary = c
      break
    }
  }

  if (!binary) {
    // Try finding via which
    try {
      binary = execSync('which ion', { encoding: 'utf-8' }).trim()
    } catch {}
  }

  if (!binary) {
    throw new Error('Cannot find ion executable')
  }

  // Spawn as child of Ion.app — keep parent process group/session intact so
  // macOS TCC attributes file-system access to Ion.app rather than recording
  // a separate identity for the engine binary.
  const isJs = binary.endsWith('.js')
  const cmd = isJs ? 'node' : binary
  const args = isJs ? [binary, 'serve'] : ['serve']

  // Spawn with the full login-shell environment, not the raw process.env.
  // A GUI-launched macOS app inherits the launchd-truncated PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin), so without this the engine — and every
  // agent Bash tool / MCP server / extension subprocess it spawns — cannot
  // see Homebrew/nvm/asdf binaries or anything on the user's real PATH.
  // getCliEnv() resolves the login-shell PATH (already used by the desktop's
  // own terminal and ipc/bash) and overlays the engine's socket/pid vars.
  const childEnv = getCliEnv({
    ION_SOCKET_PATH: socketPath,
    ION_PID_PATH: pidPath,
  })
  const resolvedPath = childEnv.PATH ?? ''
  log(
    `Engine env: PATH resolved (${resolvedPath.length} chars, ` +
      `${resolvedPath.split(':').length} entries); first: ${resolvedPath.split(':')[0] ?? '(none)'}`,
  )

  const child = spawn(cmd, args, {
    stdio: 'ignore',
    env: childEnv as NodeJS.ProcessEnv,
  })
  log(`Spawned engine server: PID ${child.pid}`)
}
