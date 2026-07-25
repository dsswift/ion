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
 *      content-changed (sha256 hash of the bytes — see hashBinary).
 *   3. Run `ion install-assets` to install SDK/ion-meta/canonical docs.
 *   4. `launchctl bootstrap` + `kickstart` the agent (kickstart retried —
 *      launchctl transiently fails while a booted-out agent tears down).
 *   5. Verify the daemon is actually up by connecting to its socket; if it
 *      never binds, retry the kickstart once, then surface the failure.
 *
 * All steps are idempotent. A no-op on Linux/Windows (daemon is macOS-only).
 */

import { execFileSync, execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import { createConnection } from 'net'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log, error as _error } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('bootstrap', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('bootstrap', msg, fields)
}

const PLIST_LABEL = 'com.ion.engine'
const PLIST_FILENAME = 'com.ion.engine.plist'
const ENGINE_SOCKET_PATH = join(homedir(), '.ion', 'engine.sock')

/**
 * Timing knobs for the kickstart-and-verify sequence. Injectable so tests can
 * exercise the retry/verify paths without real multi-second waits; production
 * callers use the defaults.
 */
export interface DaemonReadinessOpts {
  /** execSync timeout for each launchctl kickstart attempt. */
  kickstartTimeoutMs?: number
  /** Attempts per kickstart round (launchctl can transiently hang or refuse
   *  while a just-booted-out agent is still tearing down). */
  kickstartAttempts?: number
  /** Settle delay between kickstart attempts. */
  kickstartSettleMs?: number
  /** Total budget for one socket-readiness wait. */
  socketWaitMs?: number
  /** Poll interval for the socket-readiness wait. */
  socketPollMs?: number
}

const READINESS_DEFAULTS: Required<DaemonReadinessOpts> = {
  kickstartTimeoutMs: 10000,
  kickstartAttempts: 3,
  kickstartSettleMs: 1000,
  socketWaitMs: 15000,
  socketPollMs: 500,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
 */
async function kickstartDaemon(uid: number, force: boolean, opts: Required<DaemonReadinessOpts>): Promise<boolean> {
  const cmd = force
    ? `launchctl kickstart -k gui/${uid}/${PLIST_LABEL}`
    : `launchctl kickstart gui/${uid}/${PLIST_LABEL}`
  for (let attempt = 1; attempt <= opts.kickstartAttempts; attempt++) {
    try {
      execSync(cmd, { timeout: opts.kickstartTimeoutMs })
      log('engine_bootstrap: launchctl kickstart succeeded', { force_restart: force, attempt })
      return true
    } catch (err: any) {
      log('engine_bootstrap: launchctl kickstart attempt failed', {
        force_restart: force,
        attempt,
        attempts_max: opts.kickstartAttempts,
        error: err.message,
      })
      if (attempt < opts.kickstartAttempts) await sleep(opts.kickstartSettleMs)
    }
  }
  return false
}

/**
 * Poll the engine daemon socket until it accepts a connection or the budget
 * runs out. This is the fetching primitive — "kickstart returned 0" only
 * proves launchctl accepted the command, not that the engine bound its
 * socket. Each probe opens and immediately closes a real connection.
 */
export async function waitForEngineSocket(opts: Required<DaemonReadinessOpts>): Promise<boolean> {
  const deadline = Date.now() + opts.socketWaitMs
  const started = Date.now()
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const conn = createConnection(ENGINE_SOCKET_PATH)
      conn.once('connect', () => {
        conn.destroy()
        resolve(true)
      })
      conn.once('error', () => {
        conn.destroy()
        resolve(false)
      })
    })
    if (ok) {
      log('engine_bootstrap: engine socket reachable', { elapsed_ms: Date.now() - started })
      return true
    }
    if (Date.now() >= deadline) return false
    await sleep(opts.socketPollMs)
  }
}

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

/**
 * sha256 content hash of a binary, hex-encoded. Returns null if the file is
 * missing or unreadable.
 *
 * This is the precise identity check for "is the installed daemon binary the
 * same as the one we bundle?" — it replaces string-comparing `ion version`
 * output, which is only a proxy for identity and collides whenever two builds
 * share a version string (e.g. the `dev` default, or any un-bumped release).
 * A version-string match let a genuinely different binary be treated as
 * identical, so the DMG-bundled engine was never copied and the daemon was
 * never force-restarted — the stale-daemon bug. Hashing bytes is exact, is
 * cheaper than exec'ing the binary, and does not fail on a quarantined binary
 * that macOS would refuse to run.
 */
function hashBinary(binaryPath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
  } catch (err) {
    log('engine_bootstrap: hashBinary failed', { path: binaryPath, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Ensure the Ion Engine launchd daemon is installed and current.
 * Called once at desktop startup, before the bridge connects.
 *
 * Exported for testing. In production, call from app-lifecycle.ts.
 */
export async function ensureEngineDaemon(readiness: DaemonReadinessOpts = {}): Promise<void> {
  if (process.platform !== 'darwin') {
    log('Not macOS, skipping launchd daemon bootstrap')
    return
  }
  const opts: Required<DaemonReadinessOpts> = { ...READINESS_DEFAULTS, ...readiness }

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

  // ── Step 2: Copy engine binary if missing or content-changed ───────────────
  //
  // Identity is decided by a sha256 hash of the binary bytes, NOT by
  // `ion version` string equality. Two builds can share a version string (the
  // `dev` default, or any un-bumped release) while being genuinely different
  // binaries; a string match previously skipped the copy AND the force-restart,
  // so a DMG update kept running the old daemon. Hash comparison catches every
  // real change.

  const ionBinDir = join(home, '.ion', 'bin')
  const destBinary = join(ionBinDir, 'ion')
  const srcBinary = findBundledBinary()

  if (!srcBinary) {
    log('WARNING: bundled engine binary not found, skipping binary install')
  } else if (srcBinary === destBinary) {
    // Source IS the destination (globally installed binary). Nothing to copy.
    log('Engine binary is already at daemon path, skipping copy')
  } else {
    const srcHash = hashBinary(srcBinary)
    const destHash = existsSync(destBinary) ? hashBinary(destBinary) : null

    if (destHash && srcHash && destHash === srcHash) {
      log('engine_bootstrap: binary hash match, skipping copy', { hash: srcHash.slice(0, 12) })
    } else {
      log('engine_bootstrap: binary content differs, copying', {
        reason: destHash ? 'hash_mismatch' : 'missing',
        src_hash: srcHash ? srcHash.slice(0, 12) : null,
        dest_hash: destHash ? destHash.slice(0, 12) : null,
        src: srcBinary,
      })
      mkdirSync(ionBinDir, { recursive: true })
      // Install via copy-to-staging + rename so the destination gets a FRESH
      // inode. Copying onto the existing file reuses its vnode, and macOS
      // caches code-signing state per vnode: an in-place overwrite of a signed
      // Mach-O — especially one launchd is actively respawning — leaves that
      // cache poisoned, and every subsequent exec is SIGKILLed with "Taskgated
      // Invalid Signature" even though `codesign --verify` passes on disk.
      // rename() atomically swaps in the new inode, so the kernel evaluates
      // the new binary's signature from scratch.
      const stagingBinary = `${destBinary}.staging`
      copyFileSync(srcBinary, stagingBinary)
      chmodSync(stagingBinary, 0o755)
      renameSync(stagingBinary, destBinary)
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
  log('engine_bootstrap: kickstarting daemon', { force_restart: forceRestart, binary_updated: binaryUpdated, plist_changed: plistChanged })
  await kickstartDaemon(uid, forceRestart, opts)

  // ── Step 5: Verify the daemon actually came up ─────────────────────────────
  //
  // ensureEngineDaemon's contract is "installed, current, and RUNNING" — so
  // verify running with the primitive that proves it (a socket connect), not
  // by trusting launchctl's exit code. The failure this closes: during a
  // desktop-relaunch handoff the old instance boots the agent out, the new
  // instance's kickstart races the teardown and fails or lands on a dead
  // namespace, and the app then starts against a down engine — 30 restoring
  // tabs each timing out against a socket nobody was going to bring back.
  if (await waitForEngineSocket(opts)) return

  // One recovery round: re-issue the kickstart (the first may have raced the
  // bootout teardown) and wait again.
  log('engine_bootstrap: socket not reachable after kickstart, retrying kickstart')
  await kickstartDaemon(uid, forceRestart, opts)
  if (await waitForEngineSocket(opts)) return

  // Still down. Surface loudly and return — the bridge's background reconnect
  // keeps retrying, so the app is degraded but not wedged.
  error('engine_bootstrap: engine daemon failed to come up; bridge reconnect will keep retrying', {
    socket: ENGINE_SOCKET_PATH,
    force_restart: forceRestart,
  })
}

// Exported for testing
export { findPlistTemplate, findBundledBinary, hashBinary, PLIST_LABEL, PLIST_FILENAME }

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
    // 10s timeout: launchctl transiently hangs past the old 5s budget while
    // the agent namespace is busy (see kickstartDaemon). This path stays a
    // single synchronous attempt — it runs on a tray click and must not block
    // the main process through a multi-attempt retry ladder.
    execSync(`launchctl kickstart -k gui/${uid}/${PLIST_LABEL}`, { timeout: 10000 })
    log('restartEngineDaemon: launchctl kickstart -k succeeded (daemon recycled, re-reading engine.json)')
    return true
  } catch (err: any) {
    log('restartEngineDaemon: launchctl kickstart -k failed', { error: err.message })
    return false
  }
}
