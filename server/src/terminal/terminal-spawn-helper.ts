/**
 * node-pty's prebuilt `spawn-helper` (unix only) is the binary that actually
 * forks the shell for a PTY. When it is missing or not executable, every
 * terminal fails with the one-line "posix_spawnp failed." -- which names
 * neither the helper nor the fix. Observed on a headless deploy installed
 * with `npm ci --ignore-scripts`, where npm extracted the helper 0644. This
 * module turns that opaque failure into a logged diagnosis.
 */
import { accessSync, chmodSync, constants, existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'

export interface SpawnHelperStatus {
  /** Where the helper is expected for this platform/arch, or null when node-pty cannot be located. */
  path: string | null
  exists: boolean
  executable: boolean
}

/** Resolves node-pty's package directory from this module, or null when the module is not installed. */
function nodePtyDir(): string | null {
  try {
    const require = createRequire(import.meta.url)
    return dirname(require.resolve('node-pty/package.json'))
  } catch {
    return null
  }
}

/** Pure over `packageDir`: the helper's expected location and mode. Exported for tests. */
export function describeSpawnHelperIn(packageDir: string | null, platform: NodeJS.Platform = process.platform, arch: string = process.arch): SpawnHelperStatus {
  if (!packageDir || platform === 'win32') return { path: null, exists: false, executable: false }
  const path = join(packageDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper')
  const exists = existsSync(path)
  let executable = false
  if (exists) {
    try {
      accessSync(path, constants.X_OK)
      executable = true
    } catch {
      executable = false
    }
  }
  return { path, exists, executable }
}

export function describeSpawnHelper(): SpawnHelperStatus {
  return describeSpawnHelperIn(nodePtyDir())
}

/** One actionable sentence for the log when a PTY spawn fails, or null when the helper looks fine. */
export function spawnHelperHint(status: SpawnHelperStatus): string | null {
  if (!status.path) return 'node-pty is not installed where this server resolves modules'
  if (!status.exists) return `node-pty prebuilt spawn-helper missing at ${status.path}; reinstall node-pty (npm rebuild node-pty)`
  if (!status.executable) return `node-pty spawn-helper at ${status.path} is not executable; run: chmod +x ${status.path}`
  return null
}

export interface SpawnHelperRepair {
  status: SpawnHelperStatus
  /** True when the helper lacked its execute bit and this call restored it. */
  repaired: boolean
  /** The chmod's failure text when the bit was missing and could not be set (a root-owned install, a read-only mount). */
  error: string | null
}

/**
 * Restore the helper's execute bit when npm extracted it without one.
 *
 * The packaging pipeline (`desktop/scripts/afterPack.js`) and the repo's
 * `postinstall` set the bit where the files are written, so this is the
 * backstop for a tree neither touched: a `node_modules` installed with
 * `--ignore-scripts`, a hand-copied deploy. It runs before every spawn and
 * is a no-op when the bit is already set. Under `/Applications` the bundle
 * is root-owned and the chmod fails; that failure is returned so the spawn
 * log can say the bit is missing AND that the process could not fix it.
 */
export function ensureSpawnHelperExecutableIn(packageDir: string | null, platform: NodeJS.Platform = process.platform, arch: string = process.arch): SpawnHelperRepair {
  const status = describeSpawnHelperIn(packageDir, platform, arch)
  if (!status.path || !status.exists || status.executable) return { status, repaired: false, error: null }
  try {
    chmodSync(status.path, 0o755)
  } catch (err) {
    return { status, repaired: false, error: (err as Error).message }
  }
  const after = describeSpawnHelperIn(packageDir, platform, arch)
  return { status: after, repaired: after.executable, error: after.executable ? null : 'chmod succeeded but the helper is still not executable' }
}

export function ensureSpawnHelperExecutable(): SpawnHelperRepair {
  return ensureSpawnHelperExecutableIn(nodePtyDir())
}
