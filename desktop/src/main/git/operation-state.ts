/**
 * Git operation-state probe — "is this checkout mid-rebase / mid-merge, and
 * what is conflicted?"
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A conflicted `git rebase` stops halfway and leaves the checkout in detached
 * HEAD. Two things then went wrong at once: the worktree inventory skipped
 * detached-HEAD entries, so the worktree VANISHED from the panel, and nothing
 * told the operator the sync had failed. Two of five worktrees disappeared
 * mid-operation with no explanation — the checkout was not unmanaged, it was
 * mid-rebase, and the panel had no way to say so.
 *
 * ── Why the `.git` pointer file, not a hardcoded `.git/...` join ────────────
 * `GitRepository.detectMergeState()` probes `<repo>/.git/rebase-merge` etc.,
 * which is correct for a primary checkout only. A WORKTREE's state dirs live
 * under `<repo>/.git/worktrees/<id>/`, and its `.git` is a file pointer, so a
 * naive path join misses every worktree operation. This module resolves the
 * real gitdir the same way git itself does — `.git` as a directory IS the
 * gitdir; `.git` as a file names it via a `gitdir: <path>` line — and joins
 * state names onto that. The operation markers probed here (`rebase-merge`,
 * `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`) all live in the
 * PER-WORKTREE gitdir, never the shared commondir, so the join is exact for
 * both layouts.
 *
 * This used to shell out to `git rev-parse --git-path <name>` per probe —
 * correct, but 2–4 subprocess spawns per worktree per inventory crawl, which
 * multiplied into the spawn storm that froze the overlay. The pointer-file
 * read answers the same question with zero spawns.
 *
 * All probes are read-only and fail open (state `none` / empty lists): an
 * unreadable probe must degrade to "no operation detected", never block an
 * inventory or invent an operation that is not happening.
 */
import { readFileSync, existsSync, statSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { log as _log } from '../logger'
import { runGit } from '../git-runner'
import type { GitOperationState } from '../../shared/types'

const TAG = 'git.opstate'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/** Everything knowable about an in-progress git operation in one directory. */
export interface OperationProbe {
  /** The operation in progress, or absent when the checkout is quiescent. */
  state?: GitOperationState
  /**
   * The branch the operation is rewriting, when git recorded one
   * (`rebase-merge/head-name`). This is what keeps a mid-rebase worktree
   * identifiable: HEAD is detached, but the branch being rebased is known.
   */
  branch?: string
  /** What the operation is applying onto (short sha or ref), when recorded. */
  onto?: string
  /** Paths with unmerged index entries, deduped. Empty when no conflicts. */
  conflictedPaths: string[]
}

/**
 * Resolve the real gitdir for `directory` without spawning git.
 *
 * A primary checkout's `.git` is the gitdir itself. A linked worktree's `.git`
 * is a one-line pointer file (`gitdir: <path>`, absolute or relative to the
 * working tree) — the same record git consults. Null when the directory is not
 * a git checkout or the pointer is unreadable (fail open).
 */
function resolveGitDir(directory: string): string | null {
  const dotGit = join(directory, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const match = readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)\s*$/m)
    if (!match) return null
    const p = match[1].trim()
    return isAbsolute(p) ? p : resolve(directory, p)
  } catch {
    return null
  }
}

/**
 * A git state path for `directory`, absolute, or null when the directory is
 * not a checkout. Pure path arithmetic — see the module header for why this
 * is exact for both primary and linked-worktree layouts.
 */
function statePath(directory: string, name: string): string | null {
  const gitDir = resolveGitDir(directory)
  return gitDir ? join(gitDir, name) : null
}

/**
 * Read a git state file for `directory`, or null when it does not exist.
 */
function readStateFile(directory: string, name: string): string | null {
  try {
    const p = statePath(directory, name)
    if (!p) return null
    return readFileSync(p, 'utf-8').trim()
  } catch {
    // Missing file is the normal "no such operation" case; unreadable state
    // degrades the same way (fail open).
    return null
  }
}

/** True when the state path exists (file or directory). */
function stateExists(directory: string, name: string): boolean {
  const p = statePath(directory, name)
  return p !== null && existsSync(p)
}

/**
 * Paths with unmerged index entries. The same precise probe as
 * `hasMergeConflict` (worktree/integrate.ts), returning the paths rather than
 * a boolean: `ls-files --unmerged` prints one line per stage, so paths are
 * deduped.
 */
export async function unmergedPaths(directory: string): Promise<string[]> {
  try {
    const raw = await runGit(directory, ['ls-files', '--unmerged'])
    const paths = new Set<string>()
    for (const line of raw.split('\n')) {
      // Format: "<mode> <sha> <stage>\t<path>"
      const tab = line.indexOf('\t')
      if (tab > 0) paths.add(line.slice(tab + 1).trim())
    }
    return [...paths]
  } catch {
    return []
  }
}

/**
 * Probe a directory for an in-progress operation.
 *
 * The rebase branch comes from `rebase-merge/head-name` (interactive/merge
 * rebases — what sync runs) or `rebase-apply/head-name` (am-based). A merge or
 * cherry-pick does not detach HEAD, so no branch recovery is needed there.
 */
export async function probeOperationState(directory: string): Promise<OperationProbe> {
  // Order matters only for reporting; the states are mutually exclusive in git.
  if (stateExists(directory, 'rebase-merge') || stateExists(directory, 'rebase-apply')) {
    const headName =
      readStateFile(directory, 'rebase-merge/head-name') ??
      readStateFile(directory, 'rebase-apply/head-name')
    const onto =
      readStateFile(directory, 'rebase-merge/onto') ??
      readStateFile(directory, 'rebase-apply/onto')
    const branch = headName?.replace(/^refs\/heads\//, '')
    const conflictedPaths = await unmergedPaths(directory)
    log('operation detected', {
      directory,
      state: 'rebasing',
      branch: branch ?? 'unknown',
      conflicted: conflictedPaths.length,
    })
    return { state: 'rebasing', branch, onto: onto?.slice(0, 7), conflictedPaths }
  }

  if (stateExists(directory, 'MERGE_HEAD')) {
    const conflictedPaths = await unmergedPaths(directory)
    log('operation detected', { directory, state: 'merging', conflicted: conflictedPaths.length })
    return { state: 'merging', conflictedPaths }
  }

  if (stateExists(directory, 'CHERRY_PICK_HEAD')) {
    const conflictedPaths = await unmergedPaths(directory)
    log('operation detected', { directory, state: 'cherry-picking', conflicted: conflictedPaths.length })
    return { state: 'cherry-picking', conflictedPaths }
  }

  return { conflictedPaths: [] }
}
