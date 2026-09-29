/**
 * Copy-on-write capability probe.
 *
 * ── Why probe instead of checking the platform ──────────────────────────────
 * Reflink support is a property of the *volume pair*, not of the operating
 * system, and `process.platform` cannot answer it:
 *
 *   - macOS is APFS by default, but an external drive may be HFS+ or exFAT.
 *   - Linux is ext4 by default (no reflink) but Btrfs and XFS support it.
 *   - Windows NTFS has no reflink primitive at any version. ReFS does, but only
 *     on Win11 24H2 / Server 2025, only on a Dev Drive, and `C:` cannot be one.
 *   - Reflink requires source and destination on the SAME volume, so even a
 *     capable filesystem fails across a mount boundary.
 *
 * A platform check would therefore be wrong for a Btrfs Linux box, wrong for a
 * Windows Dev Drive, and wrong for a macOS user whose worktrees live on an
 * external disk. So Ion asks the filesystem instead of guessing: write a tiny
 * temp file, attempt a FORCED reflink of it, and see what happens.
 *
 * This is self-correcting. It picks up a newly formatted Dev Drive, an
 * ext4→Btrfs migration, or a future NTFS capability with no code change, and it
 * cannot be wrong about the machine it is actually running on.
 *
 * ── Why FICLONE_FORCE and not FICLONE ───────────────────────────────────────
 * Plain `COPYFILE_FICLONE` falls back to a byte copy when reflink is
 * unavailable, so it always "succeeds" and tells us nothing.
 * `COPYFILE_FICLONE_FORCE` fails loudly instead, which is exactly the signal
 * the probe needs.
 */
import { constants, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { log as _log, debug as _debug } from '../logger'

const TAG = 'worktree.provision'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }

/**
 * Probe results, keyed by `<sourceDir>\u0000<destDir>`.
 *
 * Cached because the answer cannot change for a given volume pair without the
 * operator reformatting or remounting something, and the probe does real file
 * I/O that would otherwise repeat for every seed entry of every worktree.
 */
const cache = new Map<string, boolean>()

/** Test seam: drop the cache so a fixture directory pair is re-probed. */
export function _resetCapabilityCacheForTests(): void {
  cache.clear()
}

/**
 * True when a copy-on-write clone from `sourceDir` to `destDir` is possible.
 *
 * Both directories must exist; `destDir` is created when absent, because the
 * caller is about to seed into it anyway.
 *
 * Never throws. Any failure — permissions, a missing directory, an exotic
 * filesystem — resolves to `false`, which routes the caller to the build or
 * copy rung. A probe that threw would turn "no fast path" into "no worktree".
 */
export function supportsReflink(sourceDir: string, destDir: string): boolean {
  const key = `${sourceDir}\u0000${destDir}`
  const cached = cache.get(key)
  if (cached !== undefined) {
    debug('reflink capability (cached)', { source: sourceDir, dest: destDir, supported: cached })
    return cached
  }

  const stamp = `${process.pid}-${Date.now()}`
  const probeSrc = join(sourceDir, `.ion-reflink-probe-${stamp}`)
  const probeDst = join(destDir, `.ion-reflink-probe-${stamp}.clone`)
  let supported = false

  try {
    mkdirSync(destDir, { recursive: true })
    writeFileSync(probeSrc, 'ion')
    copyFileSync(probeSrc, probeDst, constants.COPYFILE_FICLONE_FORCE)
    supported = true
  } catch (err) {
    // Expected on NTFS, ext4, and every cross-volume pair. Debug rather than
    // warn: this is a normal capability answer, not a malfunction.
    debug('reflink unavailable for this directory pair', {
      source: sourceDir, dest: destDir, error: String(err),
    })
  } finally {
    // Best-effort cleanup of both probe files. A leftover probe file would be
    // gitignored noise at best and a confusing artifact at worst.
    try { rmSync(probeSrc, { force: true }) } catch (err) { debug('probe source cleanup failed', { path: probeSrc, error: String(err) }) }
    try { rmSync(probeDst, { force: true }) } catch (err) { debug('probe clone cleanup failed', { path: probeDst, error: String(err) }) }
  }

  cache.set(key, supported)
  log('reflink capability probed', { source: sourceDir, dest: destDir, supported })
  return supported
}
