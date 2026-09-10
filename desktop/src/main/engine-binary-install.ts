/**
 * Bundled-engine-binary identity and installation: locating the binary the
 * desktop ships, hashing its content, and copying it into place. Split from
 * engine-bootstrap.ts so the dispatcher itself stays a short, readable
 * sequence of steps.
 */
import { existsSync, readFileSync, mkdirSync, copyFileSync, chmodSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('bootstrap', msg, fields)
}

/**
 * Engine binary name by platform: "ion" everywhere except win32, where it
 * is "ion.exe".
 */
export function binaryName(): string {
  return process.platform === 'win32' ? 'ion.exe' : 'ion'
}

/**
 * Name of the Windows launcher that starts the engine with no console
 * window. Windows-only by construction: the problem it solves (Task
 * Scheduler always allocating a console the daemon cannot hide) does not
 * exist under launchd.
 */
export const ENGINE_HOST_NAME = 'ion-engine-host.exe'

/**
 * Locate the bundled engine host launcher, using the same search order as
 * the engine binary. Returns null off Windows, where there is no host to
 * ship, and on a Windows tree built before the host existed.
 */
export function findBundledHost(): string | null {
  if (process.platform !== 'win32') return null
  for (const c of binaryCandidates(ENGINE_HOST_NAME)) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Locate the bundled engine binary. Checked in order:
 *   1. Packaged app: Contents/Resources/engine/<name> (darwin) or
 *      resources/engine/<name> (win32)
 *   2. Dev monorepo: <repo>/engine/bin/<name>
 *   3. Globally installed: ~/.ion/bin/<name> (already at destination)
 */
export function findBundledBinary(): string | null {
  for (const c of binaryCandidates(binaryName())) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * The places a bundled executable of the given name may live, in precedence
 * order. Shared by the engine binary and the Windows host launcher so the
 * two can never drift into searching different trees.
 */
function binaryCandidates(name: string): string[] {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'engine', name) : null,
    join(__dirname, '..', '..', '..', 'engine', 'bin', name),
    join(__dirname, '..', '..', '..', '..', 'engine', 'bin', name),
  ]
  return candidates.filter((c): c is string => c !== null)
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
 * identical, so a bundled engine was never copied and the daemon was never
 * force-restarted — the stale-daemon bug. Hashing bytes is exact, is cheaper
 * than exec'ing the binary, and does not fail on a quarantined binary that
 * macOS would refuse to run.
 */
export function hashBinary(binaryPath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
  } catch (err) {
    log('engine_bootstrap: hashBinary failed', { path: binaryPath, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Copies srcBinary to destBinary via staging-file + rename, so the
 * destination always gets a fresh inode. On darwin this defeats macOS's
 * per-vnode code-signing cache (an in-place overwrite of a signed Mach-O
 * that launchd is actively respawning gets SIGKILLed with "Taskgated
 * Invalid Signature" even though `codesign --verify` passes on disk). On
 * Windows a plain copy would work too — a stopped task's binary is not
 * held open — but using the same staging+rename path everywhere means
 * there is one code path to reason about instead of two.
 */
export function installBinary(srcBinary: string, destBinary: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  const stagingBinary = `${destBinary}.staging`
  copyFileSync(srcBinary, stagingBinary)
  chmodSync(stagingBinary, 0o755)
  renameSync(stagingBinary, destBinary)
  log('engine_bootstrap: binary installed', { path: destBinary })
}
