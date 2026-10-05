/**
 * Whether a worktree's checkout still exists as git sees it, and how to
 * finish removing one git has already let go of.
 *
 * `git worktree remove` unregisters the worktree before it deletes the
 * directory. When the delete fails part way (another process still writing
 * into it), git no longer knows the path, the directory is still there, and
 * every later `git worktree remove` answers "is not a working tree". Running
 * git inside that directory is worse than failing: git walks up to whatever
 * repository encloses it and answers for that one.
 */
import { existsSync, lstatSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { runGit } from '../git/git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.checkout'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** The path with symlinks resolved; itself when it does not exist. */
function resolved(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    // silent-ok: a missing path compares as written
    return path
  }
}

/** Whether `git worktree list` in `repoPath` still names `worktreePath`. Throws when git cannot answer. */
export async function isListedWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  const raw = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
  const want = resolved(worktreePath)
  return raw
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => resolved(line.slice('worktree '.length)) === want)
}

/** Whether git, run in `worktreePath`, answers for that directory itself rather than an enclosing repository. */
export async function isOwnCheckoutRoot(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false
  try {
    const top = (await runGit(worktreePath, ['rev-parse', '--show-toplevel'])).trim()
    return resolved(top) === resolved(worktreePath)
  } catch (err) {
    log('not a checkout root', { worktree_path: worktreePath, error: String(err) })
    return false
  }
}

/**
 * Delete what is left of a checkout git no longer lists, then let git forget
 * any stale record of it. Refuses a directory that holds a repository of its
 * own (`.git` as a directory) or is the repository itself: those are never
 * leftovers.
 */
export async function removeLeftoverCheckout(repoPath: string, worktreePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (resolved(worktreePath) === resolved(repoPath)) {
    warn('leftover removal refused: path is the repository', { repo_path: repoPath, worktree_path: worktreePath })
    return { ok: false, error: 'Refusing to delete the repository itself.' }
  }
  const dotGit = join(worktreePath, '.git')
  if (existsSync(dotGit) && lstatSync(dotGit).isDirectory()) {
    warn('leftover removal refused: directory holds its own repository', { worktree_path: worktreePath })
    return { ok: false, error: `${worktreePath} holds a repository of its own, so it was not deleted.` }
  }
  try {
    rmSync(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    log('leftover checkout removed', { worktree_path: worktreePath })
  } catch (err) {
    warn('leftover checkout removal failed', { worktree_path: worktreePath, error: String(err) })
    return { ok: false, error: `Could not delete ${worktreePath}: ${String(err)}` }
  }
  try {
    await runGit(repoPath, ['worktree', 'prune'])
  } catch (err) {
    log('worktree prune after leftover removal failed', { repo_path: repoPath, error: String(err) })
  }
  return { ok: true }
}

/** Commits on `branchName` that `sourceBranch` lacks, read from the repository. 0 when the branch is gone. Throws when git cannot answer. */
export async function unlandedOnBranch(repoPath: string, branchName: string, sourceBranch: string): Promise<{ count: number; tip: string | null }> {
  let tip: string
  try {
    tip = (await runGit(repoPath, ['rev-parse', '--verify', `refs/heads/${branchName}`])).trim()
  } catch {
    // silent-ok: a missing branch holds no commits; logged by the caller's appraisal line
    return { count: 0, tip: null }
  }
  const raw = await runGit(repoPath, ['log', '--format=%H', `${sourceBranch}..${tip}`])
  return { count: raw.split('\n').filter(Boolean).length, tip }
}
