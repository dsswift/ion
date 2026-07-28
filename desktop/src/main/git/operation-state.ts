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
 * ── Why `--git-path`, not a hardcoded `.git/...` join ───────────────────────
 * `GitRepository.detectMergeState()` probes `<repo>/.git/rebase-merge` etc.,
 * which is correct for a primary checkout only. A WORKTREE's state dirs live
 * under `<repo>/.git/worktrees/<id>/`, and its `.git` is a file pointer, so a
 * path join misses every worktree operation. `git rev-parse --git-path X`
 * resolves per-worktree correctly for both layouts, which is why this module
 * asks git instead of joining paths.
 *
 * All probes are read-only and fail open (state `none` / empty lists): an
 * unreadable probe must degrade to "no operation detected", never block an
 * inventory or invent an operation that is not happening.
 */
import { readFileSync, existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
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
 * Resolve a git state path for `directory`, absolute.
 *
 * `--git-path` answers relative to the WORKING TREE for a primary checkout
 * (`.git/rebase-merge`) and absolute for a linked worktree — so a relative
 * answer must be resolved against `directory`, never the process cwd.
 */
async function statePath(directory: string, name: string): Promise<string | null> {
  try {
    const p = (await runGit(directory, ['rev-parse', '--git-path', name])).trim()
    return isAbsolute(p) ? p : resolve(directory, p)
  } catch {
    return null
  }
}

/**
 * Read a git state file for `directory`, or null when it does not exist.
 * `--git-path` is what makes this worktree-correct.
 */
async function readStateFile(directory: string, name: string): Promise<string | null> {
  try {
    const p = await statePath(directory, name)
    if (!p) return null
    return readFileSync(p, 'utf-8').trim()
  } catch {
    // Missing file is the normal "no such operation" case; unreadable state
    // degrades the same way (fail open).
    return null
  }
}

/** True when the state path exists (file or directory). */
async function stateExists(directory: string, name: string): Promise<boolean> {
  const p = await statePath(directory, name)
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
  if (await stateExists(directory, 'rebase-merge') || await stateExists(directory, 'rebase-apply')) {
    const headName =
      (await readStateFile(directory, 'rebase-merge/head-name')) ??
      (await readStateFile(directory, 'rebase-apply/head-name'))
    const onto =
      (await readStateFile(directory, 'rebase-merge/onto')) ??
      (await readStateFile(directory, 'rebase-apply/onto'))
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

  if (await stateExists(directory, 'MERGE_HEAD')) {
    const conflictedPaths = await unmergedPaths(directory)
    log('operation detected', { directory, state: 'merging', conflicted: conflictedPaths.length })
    return { state: 'merging', conflictedPaths }
  }

  if (await stateExists(directory, 'CHERRY_PICK_HEAD')) {
    const conflictedPaths = await unmergedPaths(directory)
    log('operation detected', { directory, state: 'cherry-picking', conflicted: conflictedPaths.length })
    return { state: 'cherry-picking', conflictedPaths }
  }

  return { conflictedPaths: [] }
}
