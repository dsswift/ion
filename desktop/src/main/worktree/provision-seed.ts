/**
 * Seeding one declared path into a new worktree.
 *
 * ── The ladder ──────────────────────────────────────────────────────────────
 *   1. clone — copy-on-write reflink. Near-zero time and disk.
 *   2. build — run the project's declared install command.
 *   3. copy  — byte copy. Last resort, only when no build command exists.
 *
 * **Sharing is permanently absent from that ladder.** A symlinked `node_modules`
 * is ONE inode with two names: an `npm install` in any worktree mutates the main
 * clone and every sibling. That is the same cross-contamination class as the cwd
 * defect, and it is what was improvised (and failed) before this module existed
 * — Node's resolver walked out of the symlink and could not find `vitest/config`.
 *
 * A manifest may explicitly opt one regular, primary-owned cache file into a
 * `link` seed. It never enters this ladder, is never built from a worktree, and
 * remains protected by workspace containment if a tool attempts to write through
 * the link.
 *
 * **A clone is safe to write to, which is the whole point.** A reflink is a
 * separate inode that happens to share physical blocks; the first write to
 * either side duplicates the affected blocks. So `npm install` inside a cloned
 * worktree is fully independent of the source and costs only its real delta.
 *
 * **Build outranks copy.** Both produce equally independent trees, so copy's
 * only advantage is working offline while its cost is unbounded (hundreds of
 * thousands of small files, each scanned by AV on Windows). Build is also more
 * correct: it reconciles against the worktree's own lockfile rather than
 * snapshotting whatever state the source happened to be in.
 */
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync } from 'fs'
import { dirname, join } from 'path'
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'
import { supportsReflink } from './provision-capability'
import { runProvisionCommand } from './provision-run'
import type { SeedEntry } from './provision-manifest'

const TAG = 'worktree.provision'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** How a seed entry was satisfied, or why it was not. */
export type SeedStrategy = 'link' | 'clone' | 'build' | 'copy' | 'skipped' | 'failed'

export interface SeedResult {
  path: string
  strategy: SeedStrategy
  /** Why the entry was skipped or failed. Absent on success. */
  reason?: string
  elapsedMs: number
}

/**
 * True when git ignores `relPath` inside `repoPath`.
 *
 * ── Why this gate exists ────────────────────────────────────────────────────
 * Seeding a path git does NOT ignore leaves it as an untracked entry in `git
 * status`. That is exactly the defect observed in the field: an improvised
 * `node_modules` showed up as `?? node_modules`, and the agent had to remember
 * to delete it before committing. A provisioning feature that dirties the
 * working tree has failed at its own job, so a non-ignored path is refused
 * rather than seeded.
 *
 * `git check-ignore` exits 0 when the path IS ignored and 1 when it is not, so
 * the non-zero exit is the answer rather than an error.
 *
 * ── Why the trailing-slash retry ────────────────────────────────────────────
 * A directory-only pattern (`node_modules/`, the form nearly every .gitignore
 * uses) matches a bare path ONLY when that path already exists as a directory.
 * On a first seed the destination does not exist yet, so the bare check returns
 * "not ignored" and the guard would refuse the very case it is meant to allow.
 * Re-asking with an explicit trailing slash tells git to treat the path as a
 * directory, which matches the pattern. Verified in both directions: it makes
 * `build-cache` match `build-cache/` when absent, and it does NOT make an
 * unignored `src/` match anything.
 */
async function isGitIgnored(repoPath: string, relPath: string): Promise<boolean> {
  const ask = async (candidate: string): Promise<boolean> => {
    try {
      await runGit(repoPath, ['check-ignore', '--quiet', '--', candidate])
      return true
    } catch {
      // silent-ok: exit 1 means "not ignored", which is a legitimate answer this
      // function converts to `false`. The caller logs the resulting refusal.
      return false
    }
  }
  if (await ask(relPath)) return true
  return relPath.endsWith('/') ? false : ask(`${relPath}/`)
}

/**
 * Materialise one seed entry in `worktreePath`.
 *
 * Every outcome logs with its strategy and elapsed time, so the choice the
 * ladder made is reconstructable from `~/.ion/desktop.jsonl` alone.
 */
export async function seedEntry(
  repoPath: string,
  worktreePath: string,
  entry: SeedEntry,
): Promise<SeedResult> {
  const startedAt = Date.now()
  const done = (strategy: SeedStrategy, reason?: string): SeedResult => {
    const result = { path: entry.path, strategy, reason, elapsedMs: Date.now() - startedAt }
    if (strategy === 'failed') {
      warn('seed entry failed', { ...result, worktree_path: worktreePath })
    } else {
      log('seed entry settled', { ...result, worktree_path: worktreePath })
    }
    return result
  }

  // Guard 1: never seed a path git tracks or would report as untracked.
  if (!(await isGitIgnored(repoPath, entry.path))) {
    return done('skipped', 'path is not gitignored; seeding it would dirty git status')
  }

  const source = join(repoPath, entry.path)
  const dest = join(worktreePath, entry.path)

  if (entry.link) return seedLinkedFile(source, dest, done)

  // Already present (a re-provision, or the build command created it earlier in
  // this run). Nothing to do; the staleness reconciler decides if it is current.
  if (existsSync(dest)) {
    return done('skipped', 'already present in the worktree')
  }

  const sourceExists = existsSync(source)

  // Rung 1 — clone. Requires a source to clone FROM and a capable volume pair.
  if (sourceExists && supportsReflink(source, worktreePath)) {
    try {
      cpSync(source, dest, {
        recursive: true,
        // Try a reflink per file; fall back to a byte copy for any file the
        // filesystem refuses rather than aborting the whole tree.
        mode: constants.COPYFILE_FICLONE,
        // Preserve mtimes: tools that key on them (graphify's manifest, make,
        // incremental compilers) would otherwise treat every seeded file as
        // changed and redo work the clone just made free.
        preserveTimestamps: true,
        // Copy symlinks as symlinks. Dereferencing would explode a
        // node_modules/.bin tree into duplicated real files.
        dereference: false,
        errorOnExist: false,
      })
      return done('clone')
    } catch (err) {
      warn('clone failed; falling through to the next rung', {
        path: entry.path, source, dest, error: String(err),
      })
    }
  }

  // Rung 2 — build. Preferred over copy whenever the project declared a command.
  if (entry.build) {
    const cwd = entry.cwd ? join(worktreePath, entry.cwd) : worktreePath
    const result = await runProvisionCommand(entry.build, cwd)
    if (result.ok) return done('build')
    return done('failed', `build command failed: ${result.error ?? 'unknown'}`)
  }

  // Rung 3 — copy. Only reachable when the project declared no way to rebuild.
  if (!sourceExists) {
    return done('skipped', 'nothing to copy and no build command declared')
  }
  try {
    cpSync(source, dest, {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
      errorOnExist: false,
    })
    return done('copy')
  } catch (err) {
    return done('failed', `copy failed: ${String(err)}`)
  }
}


/** Materialise an explicitly shared, primary-owned regular file. */
function seedLinkedFile(
  source: string,
  dest: string,
  done: (strategy: SeedStrategy, reason?: string) => SeedResult,
): SeedResult {
  let sourceStat: ReturnType<typeof lstatSync>
  try {
    sourceStat = lstatSync(source)
  } catch {
    return done('skipped', 'linked source file is absent; graphify remains optional')
  }
  if (!sourceStat.isFile()) {
    return done('failed', 'linked source must be a regular file')
  }

  try {
    const destStat = lstatSync(dest)
    if (destStat.isSymbolicLink() && readlinkSync(dest) === source) {
      return done('skipped', 'already linked to the primary checkout')
    }
    return done('failed', 'destination already exists and is not the expected primary link')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return done('failed', `could not inspect destination: ${String(err)}`)
  }

  try {
    mkdirSync(dirname(dest), { recursive: true })
    symlinkSync(source, dest, 'file')
    return done('link')
  } catch (err) {
    return done('failed', `could not create primary link: ${String(err)}`)
  }
}

/**
 * Re-run `build` when the worktree's `staleWhen` files disagree with the
 * source's — i.e. the seeded tree predates the worktree's own dependencies.
 *
 * Compared by content, not mtime: a clone preserves timestamps by design, so an
 * mtime comparison would report every cloned lockfile as identical even after a
 * real divergence, and a copy without `preserveTimestamps` would report every
 * file as different. Content is the only comparison that means the same thing
 * on both rungs.
 *
 * Returns true when a rebuild ran and succeeded.
 */
export async function reconcileStale(
  repoPath: string,
  worktreePath: string,
  entry: SeedEntry,
): Promise<boolean> {
  if (!entry.build || !entry.staleWhen?.length) return false

  const diverged = entry.staleWhen.filter((rel) => {
    const a = join(repoPath, rel)
    const b = join(worktreePath, rel)
    if (!existsSync(a) || !existsSync(b)) return true
    try {
      // Size first: cheap, and a differing size is already a divergence.
      if (statSync(a).size !== statSync(b).size) return true
      return readFileSafe(a) !== readFileSafe(b)
    } catch (err) {
      warn('staleness comparison failed; assuming stale', { file: rel, error: String(err) })
      return true
    }
  })

  if (diverged.length === 0) {
    log('seed is current; no rebuild needed', { path: entry.path, worktree_path: worktreePath })
    return false
  }

  log('seed is stale; rebuilding', { path: entry.path, diverged, worktree_path: worktreePath })
  const cwd = entry.cwd ? join(worktreePath, entry.cwd) : worktreePath
  const result = await runProvisionCommand(entry.build, cwd)
  if (!result.ok) {
    warn('stale rebuild failed; the seeded tree may not match this worktree', {
      path: entry.path, error: result.error ?? 'unknown',
    })
    return false
  }
  return true
}

/** Read a file as UTF-8, or return a sentinel that never compares equal. */
function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    warn('could not read file for staleness comparison', { path, error: String(err) })
    return `__unreadable__${Math.random()}`
  }
}
