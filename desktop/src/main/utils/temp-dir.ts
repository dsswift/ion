/**
 * Operation-scoped temporary directories with guaranteed cleanup.
 *
 * Each call to `createOperationDir` creates a unique subdirectory under
 * `~/.ion/tmp/<prefix>-<uuid>/` so concurrent operations never collide.
 * `cleanupDir` removes the directory and its contents; callers should
 * invoke it from a `finally` block.
 *
 * Using `~/.ion/tmp/` (not `os.tmpdir()`) keeps temp files under Ion's
 * own tree where they survive the brief lifetime of the operation but
 * are clearly Ion-owned and safe to remove after Electron has acquired its
 * single-instance lock. There is no age heuristic: a live second desktop is
 * forbidden before startup reaches this code.
 */

import { mkdirSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('tmp', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('tmp', msg, fields) }

const ION_TMP_ROOT = join(homedir(), '.ion', 'tmp')

export function createOperationDir(prefix: string): string {
  const id = crypto.randomUUID()
  const dir = join(ION_TMP_ROOT, `${prefix}-${id}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    warn('temp dir cleanup failed', { dir, error: (err as Error).message })
  }
}

export function cleanupFile(filePath: string): void {
  try {
    rmSync(filePath, { force: true })
  } catch (err) {
    warn('temp file cleanup failed', { path: filePath, error: (err as Error).message })
  }
}

/** Remove abandoned Ion operation directories after single-instance ownership. */
export function pruneOperationDirs(): void {
  try {
    const entries = readdirSync(ION_TMP_ROOT, { withFileTypes: true })
    let pruned = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      rmSync(join(ION_TMP_ROOT, entry.name), { recursive: true, force: true })
      pruned++
    }
    if (pruned > 0) log('pruned abandoned operation dirs', { count: pruned })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn('operation dir reap failed', { root: ION_TMP_ROOT, error: String(err) })
    }
  }
}
