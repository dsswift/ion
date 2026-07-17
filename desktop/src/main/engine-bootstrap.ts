/**
 * First-launch engine bootstrap.
 *
 * Ensures the Ion Engine launchd daemon is installed and current every time
 * the desktop starts. This single module serves both install routes (source
 * build and DMG package) so they cannot drift.
 *
 * Steps (idempotent):
 *   1. Write/refresh ~/Library/LaunchAgents/com.ion.engine.plist from the
 *      bundled template, substituting $HOME with the real home directory.
 *   2. Copy the bundled engine binary to ~/.ion/bin/ion if missing or
 *      version-mismatched (compare `ion version` output).
 *   3. Run `ion install-assets` to install SDK/ion-meta/canonical docs.
 *   4. `launchctl bootstrap` + `kickstart` the agent.
 *
 * All steps are idempotent. A no-op on Linux/Windows (daemon is macOS-only).
 */

import { execFileSync, execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('bootstrap', msg, fields)
}

const PLIST_LABEL = 'com.ion.engine'
const PLIST_FILENAME = 'com.ion.engine.plist'

/**
 * Locate the plist template. Checked in order:
 *   1. Packaged .app: Contents/Resources/engine/com.ion.engine.plist
 *   2. Dev monorepo: <repo>/packaging/launchd/com.ion.engine.plist
 */
function findPlistTemplate(): string | null {
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
 * Locate the bundled engine binary. Checked in order:
 *   1. Packaged .app: Contents/Resources/engine/ion
 *   2. Dev monorepo: <repo>/engine/bin/ion
 *   3. Globally installed: ~/.ion/bin/ion (already at destination)
 */
function findBundledBinary(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'engine', 'ion') : null,
    join(__dirname, '..', '..', '..', 'engine', 'bin', 'ion'),
    join(__dirname, '..', '..', '..', '..', 'engine', 'bin', 'ion'),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

/** Read the output of `ion version` for a given binary path. Returns null on failure. */
function getVersion(binaryPath: string): string | null {
  try {
    return execFileSync(binaryPath, ['version'], { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch (err) {
    log('engine_bootstrap: getVersion failed', { path: binaryPath, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Ensure the Ion Engine launchd daemon is installed and current.
 * Called once at desktop startup, before the bridge connects.
 *
 * Exported for testing. In production, call from app-lifecycle.ts.
 */
export async function ensureEngineDaemon(): Promise<void> {
  if (process.platform !== 'darwin') {
    log('Not macOS, skipping launchd daemon bootstrap')
    return
  }

  const home = homedir()
  const uid = process.getuid?.() ?? 501

  // Track whether the plist or the binary actually changed this launch. The
  // force-restart (kickstart -k) is only justified when one of them did — the
  // engine is a persistent launchd daemon that outlives the desktop, so an
  // unconditional -k on every relaunch would force-kill a healthy daemon and
  // any in-flight work for no reason. See the Step-4 gate below.
  let plistChanged = false
  let binaryUpdated = false

  // ── Step 1: Write/refresh plist ────────────────────────────────────────────

  const templatePath = findPlistTemplate()
  if (!templatePath) {
    log('WARNING: plist template not found, skipping plist install')
  } else {
    const template = readFileSync(templatePath, 'utf-8')
    const rendered = template.replace(/\$HOME/g, home)

    const launchAgentsDir = join(home, 'Library', 'LaunchAgents')
    mkdirSync(launchAgentsDir, { recursive: true })
    const plistDest = join(launchAgentsDir, PLIST_FILENAME)

    // Only write if content changed (avoids unnecessary launchd reload)
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
  }

  // ── Step 2: Copy engine binary if missing or version-mismatched ────────────

  const ionBinDir = join(home, '.ion', 'bin')
  const destBinary = join(ionBinDir, 'ion')
  const srcBinary = findBundledBinary()

  if (!srcBinary) {
    log('WARNING: bundled engine binary not found, skipping binary install')
  } else if (srcBinary === destBinary) {
    // Source IS the destination (globally installed binary). Nothing to copy.
    log('Engine binary is already at daemon path, skipping copy')
  } else {
    const srcVersion = getVersion(srcBinary)
    const destVersion = existsSync(destBinary) ? getVersion(destBinary) : null

    if (destVersion && destVersion === srcVersion) {
      log('engine_bootstrap: binary version match, skipping copy', { version: destVersion })
    } else {
      log(
        `Engine binary ${destVersion ? `version mismatch (${destVersion} -> ${srcVersion})` : 'missing'}` +
        `, copying from ${srcBinary}`,
      )
      mkdirSync(ionBinDir, { recursive: true })
      copyFileSync(srcBinary, destBinary)
      chmodSync(destBinary, 0o755)
      binaryUpdated = true
      log('engine_bootstrap: binary installed', { path: destBinary })
    }
  }

  // ── Step 3: Run install-assets ─────────────────────────────────────────────
  //
  // Must run from srcBinary (the bundled binary), not destBinary (the installed
  // copy). The install-assets command resolves its asset root by walking up from
  // the executable directory looking for an adjacent extensions/ tree. That tree
  // exists at Contents/Resources/engine/extensions/ — next to srcBinary — but
  // NOT next to destBinary (~/.ion/bin/ion), which has no sibling extensions/.

  if (!srcBinary) {
    log('WARNING: bundled engine binary not found, skipping install-assets')
  } else {
    try {
      const output = execFileSync(srcBinary, ['install-assets'], {
        encoding: 'utf-8',
        timeout: 30000,
      })
      log('engine_bootstrap: install-assets done', { msg: output.trim().split('\n').pop() || 'done' })
    } catch (err: any) {
      log('engine_bootstrap: install-assets failed (non-fatal)', { error: err.message })
    }
  }

  // ── Step 4: Bootstrap + kickstart the LaunchAgent ──────────────────────────

  const plistDest = join(home, 'Library', 'LaunchAgents', PLIST_FILENAME)
  if (!existsSync(plistDest)) {
    log('WARNING: plist not installed, cannot bootstrap daemon')
    return
  }

  // Bootstrap loads the plist into the launchd namespace. It fails with
  // exit code 5 (or "service already loaded") if already loaded, which is
  // expected on subsequent launches.
  try {
    execSync(`launchctl bootstrap gui/${uid} ${plistDest}`, { timeout: 5000 })
    log('launchctl bootstrap succeeded')
  } catch (err: any) {
    // Exit 5 = "service already loaded" on macOS. Not an error.
    const msg = err.message || ''
    if (msg.includes('already loaded') || msg.includes('service already loaded') || err.status === 5) {
      log('LaunchAgent already loaded (expected on subsequent launches)')
    } else {
      log('engine_bootstrap: launchctl bootstrap note', { msg })
    }
  }

  // Kickstart ensures the daemon is running. The -k flag force-restarts a
  // running daemon (kill + respawn); plain kickstart starts it only if it is
  // not already running and is a no-op otherwise.
  //
  // Gate the force-restart on an actual change. The engine daemon is
  // persistent and outlives the desktop: a relaunch where neither the binary
  // nor the plist changed must NOT kill a healthy daemon (and its in-flight
  // work). Only force-restart when we installed a new binary or rewrote the
  // plist — that is when the running daemon is genuinely stale. Otherwise use
  // a non-destructive kickstart, which together with RunAtLoad + KeepAlive
  // guarantees the daemon is up (covering the case where a prior graceful quit
  // booted it out) without disturbing a running one.
  const forceRestart = binaryUpdated || plistChanged
  const kickstartCmd = forceRestart
    ? `launchctl kickstart -k gui/${uid}/${PLIST_LABEL}`
    : `launchctl kickstart gui/${uid}/${PLIST_LABEL}`
  try {
    execSync(kickstartCmd, { timeout: 5000 })
    if (forceRestart) {
      log('engine_bootstrap: launchctl kickstart succeeded', { binary_updated: binaryUpdated, plist_changed: plistChanged })
    } else {
      log('launchctl kickstart succeeded (no change — daemon left running if already up)')
    }
  } catch (err: any) {
    log('engine_bootstrap: launchctl kickstart failed', { force_restart: forceRestart, error: err.message })
  }
}

// Exported for testing
export { findPlistTemplate, findBundledBinary, getVersion, PLIST_LABEL, PLIST_FILENAME }

/**
 * Force-restart the running engine daemon so it re-reads engine.json.
 *
 * The engine is a persistent launchd daemon that outlives the desktop and reads
 * engine.json exactly ONCE at process start. A config change (backend, model,
 * logging, egress, ...) therefore does not take effect until the daemon
 * restarts. This is the on-demand restart affordance: it force-restarts the
 * daemon in place (`launchctl kickstart -k`) WITHOUT quitting the desktop or
 * killing background work beyond the engine process itself — the daemon comes
 * straight back up (RunAtLoad + KeepAlive) with fresh config.
 *
 * This is distinct from Quit All (which boots the daemon OUT so it stays down
 * until the next desktop launch) and from Quit Desktop (which leaves the daemon
 * untouched). Here the daemon is intentionally recycled and immediately
 * respawned by launchd.
 *
 * No-op on non-macOS (the daemon is macOS-only). Returns true when the kickstart
 * command was issued successfully.
 */
export function restartEngineDaemon(): boolean {
  if (process.platform !== 'darwin') {
    log('restartEngineDaemon: not macOS, skipping')
    return false
  }
  const uid = process.getuid?.() ?? 501
  try {
    execSync(`launchctl kickstart -k gui/${uid}/${PLIST_LABEL}`, { timeout: 5000 })
    log('restartEngineDaemon: launchctl kickstart -k succeeded (daemon recycled, re-reading engine.json)')
    return true
  } catch (err: any) {
    log('restartEngineDaemon: launchctl kickstart -k failed', { error: err.message })
    return false
  }
}
