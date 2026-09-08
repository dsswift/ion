/**
 * launchd EngineSupervisor: install/start/stop the Ion Engine LaunchAgent.
 * Moved verbatim (same steps, same log lines) out of engine-bootstrap.ts's
 * former monolithic ensureEngineDaemon/restartEngineDaemon, split out only so
 * the darwin mechanism lives beside its Windows sibling behind one shared
 * interface (engine-supervisor.ts).
 */
import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { log as _log } from './logger'
import type { EngineSupervisor, SupervisorOpts } from './engine-supervisor'

const execFileAsync = promisify(execFile)

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('bootstrap', msg, fields)
}

export const PLIST_LABEL = 'com.ion.engine'
export const PLIST_FILENAME = 'com.ion.engine.plist'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Locate the plist template. Checked in order:
 *   1. Packaged .app: Contents/Resources/engine/com.ion.engine.plist
 *   2. Dev monorepo: <repo>/packaging/launchd/com.ion.engine.plist
 */
export function findPlistTemplate(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'engine', PLIST_FILENAME) : null,
    join(__dirname, '..', '..', '..', 'packaging', 'launchd', PLIST_FILENAME),
    join(__dirname, '..', '..', '..', '..', 'packaging', 'launchd', PLIST_FILENAME),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

/**
 * Issue `launchctl kickstart` with retries. launchctl transiently fails
 * (observed: `spawnSync /bin/sh ETIMEDOUT` under the old 5s timeout) when the
 * agent namespace is still settling from a just-completed `bootout` — the
 * exact state during a desktop-relaunch handoff, where the quitting instance
 * boots the agent out while the new instance re-bootstraps it. A single
 * swallowed failure here left the engine down for the whole app session
 * (nothing retried, nothing verified), so every retry is logged and the
 * outcome is returned for the caller's verify step.
 *
 * Runs via awaited execFile, never execSync: this is the main thread, and a
 * synchronous launchctl call freezes the renderer's IPC for its whole duration.
 */
async function kickstartDaemon(uid: number, force: boolean, opts: SupervisorOpts): Promise<boolean> {
  const args = force
    ? ['kickstart', '-k', `gui/${uid}/${PLIST_LABEL}`]
    : ['kickstart', `gui/${uid}/${PLIST_LABEL}`]
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      await execFileAsync('launchctl', args, { timeout: opts.commandTimeoutMs })
      log('engine_bootstrap: launchctl kickstart succeeded', { force_restart: force, attempt })
      return true
    } catch (err: any) {
      log('engine_bootstrap: launchctl kickstart attempt failed', {
        force_restart: force,
        attempt,
        attempts_max: opts.attempts,
        error: err.message,
      })
      if (attempt < opts.attempts) await sleep(opts.settleMs)
    }
  }
  return false
}

/**
 * install writes/refreshes the LaunchAgent plist from the bundled template
 * (substituting $HOME), then bootstraps it into the launchd namespace.
 * Returns true when the plist content actually changed this call.
 */
async function install(binPath: string, _opts: SupervisorOpts): Promise<boolean> {
  const home = homedir()
  const uid = process.getuid?.() ?? 501
  let plistChanged = false

  const templatePath = findPlistTemplate()
  if (!templatePath) {
    log('WARNING: plist template not found, skipping plist install')
    return false
  }

  const template = readFileSync(templatePath, 'utf-8')
  // binPath substitutes for $HOME/.ion/bin/ion inside the template; the
  // template itself only ever references $HOME, so this call renders the
  // conventional destination the same way it always has. binPath is
  // accepted for interface parity with the schtasks supervisor, which
  // genuinely needs it (the task XML has no $HOME placeholder of its own).
  void binPath
  const rendered = template.replace(/\$HOME/g, home)

  const launchAgentsDir = join(home, 'Library', 'LaunchAgents')
  mkdirSync(launchAgentsDir, { recursive: true })
  const plistDest = join(launchAgentsDir, PLIST_FILENAME)

  let needsWrite = true
  if (existsSync(plistDest)) {
    const existing = readFileSync(plistDest, 'utf-8')
    if (existing === rendered) {
      log('Plist unchanged, skipping write')
      needsWrite = false
    }
  }

  if (needsWrite) {
    writeFileSync(plistDest, rendered, { mode: 0o644 })
    plistChanged = true
    log('engine_bootstrap: plist written', { path: plistDest })
  }

  if (!existsSync(plistDest)) {
    log('WARNING: plist not installed, cannot bootstrap daemon')
    return plistChanged
  }

  // Bootstrap loads the plist into the launchd namespace. It fails with
  // exit code 5 (or "service already loaded") if already loaded, which is
  // expected on subsequent launches. Awaited for the same reason as the
  // kickstart below: a synchronous launchctl call blocks the main thread.
  try {
    await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, plistDest], { timeout: 5000 })
    log('launchctl bootstrap succeeded')
  } catch (err: any) {
    const msg = err.message || ''
    if (msg.includes('already loaded') || msg.includes('service already loaded') || err.status === 5) {
      log('LaunchAgent already loaded (expected on subsequent launches)')
    } else {
      log('engine_bootstrap: launchctl bootstrap note', { msg })
    }
  }

  return plistChanged
}

/**
 * start kickstarts the daemon. force-restart (-k) kills and respawns a
 * running daemon; without force this only starts a stopped one — the
 * engine is a persistent daemon that outlives the desktop, so an
 * unconditional -k on every relaunch would force-kill a healthy daemon and
 * any in-flight work for no reason.
 */
async function start(force: boolean, opts: SupervisorOpts): Promise<void> {
  const uid = process.getuid?.() ?? 501
  log('engine_bootstrap: kickstarting daemon', { force_restart: force })
  await kickstartDaemon(uid, force, opts)
}

/**
 * stop issues `launchctl bootout`, which removes the agent from the launchd
 * bootstrap namespace (preventing KeepAlive from restarting it) — distinct
 * from a plain kickstart, which only affects a running process, not the
 * namespace registration.
 */
async function stop(opts: SupervisorOpts): Promise<void> {
  const home = homedir()
  const uid = process.getuid?.() ?? 501
  const plistPath = join(home, 'Library', 'LaunchAgents', PLIST_FILENAME)
  try {
    await execFileAsync('launchctl', ['bootout', `gui/${uid}`, plistPath], { timeout: opts.commandTimeoutMs })
    log('launchctl bootout succeeded')
  } catch (err: any) {
    // 3 = "No such process" (already unloaded). Not an error.
    if (err.status !== 3) {
      log('engine_bridge: launchctl bootout failed', { error: err.message })
    }
  }
}

async function isRegistered(): Promise<boolean> {
  const home = homedir()
  const plistDest = join(home, 'Library', 'LaunchAgents', PLIST_FILENAME)
  return existsSync(plistDest)
}

export const launchdSupervisor: EngineSupervisor = {
  name: 'launchd',
  install,
  start,
  stop,
  isRegistered,
}
