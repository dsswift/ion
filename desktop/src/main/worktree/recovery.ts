/**
 * Recovery refs — the durable copy a force-retire promises before it destroys.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The retire confirmation tells the operator "Work is preserved to a recovery
 * ref first". Nothing implemented that: `retireWorktree` ran
 * `git worktree remove --force`, and the renderer passes `force: true`
 * unconditionally once the operator confirms against the appraisal. So a retire
 * of a dirty worktree destroyed the uncommitted work outright while the dialog
 * said it had been saved. The dialog was not wrong about what SHOULD happen —
 * per the repository's aspirational-comment rule, the missing mechanism is the
 * defect, so this module is that mechanism.
 *
 * ── What it writes ──────────────────────────────────────────────────────────
 * A single commit containing the worktree's full state (tracked modifications,
 * staged content, and untracked-but-not-ignored files), stored on a ref under
 * `refs/ion/recovery/`. The ref lives in the PARENT repo, so it survives the
 * worktree directory being deleted and is reachable from any checkout of that
 * repo.
 *
 * The commit is written with plumbing (`write-tree` / `commit-tree` /
 * `update-ref`) against a TEMPORARY index rather than with `git stash` or
 * `git commit`:
 *
 *   - `git stash` mutates the operator's stash list and the working tree, and
 *     stash entries are a UI surface the operator curates. Retiring a worktree
 *     must not push entries into it.
 *   - `git commit` would move the worktree's branch HEAD, changing what the
 *     appraisal just measured, moments before the branch is deleted anyway.
 *   - A temporary index (`GIT_INDEX_FILE`) means the operator's real index is
 *     never touched, so a recovery snapshot cannot disturb a staged-but-
 *     uncommitted state that the operator is mid-way through building.
 *
 * ── Why it is not fatal ─────────────────────────────────────────────────────
 * A recovery-ref failure does NOT abort the retire — it downgrades it. The
 * caller refuses to force-delete when the snapshot could not be written, which
 * is the safe direction: the operator keeps the worktree and the work. Refusing
 * is the only honest outcome, because the alternative is destroying work after
 * telling the operator it was saved.
 */
import { rmSync } from 'fs'
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.recovery'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Where recovery refs live in the parent repo. */
export const RECOVERY_REF_PREFIX = 'refs/ion/recovery'

export interface RecoverySnapshot {
  /** Full ref name written, e.g. `refs/ion/recovery/wt-a1b2-1730000000`. */
  ref: string
  /** Commit SHA the ref points at. */
  sha: string
  /** Paths captured in the snapshot, for the log and the operator message. */
  paths: string[]
}

export interface RecoveryResult {
  /** The snapshot, when one was needed AND written. */
  snapshot?: RecoverySnapshot
  /** True when the worktree was clean, so there was nothing to preserve. */
  nothingToPreserve?: boolean
  /** Set when a snapshot was needed but could not be written. */
  error?: string
}

/**
 * Every path in the worktree that would be lost by a force-remove: tracked
 * modifications, staged entries, and untracked files. Ignored files are
 * excluded — they are reproducible by definition (`node_modules`, build
 * caches), and including them would make the snapshot enormous.
 *
 * Uses `status --porcelain` with `--untracked-files=all` so an untracked
 * DIRECTORY is expanded into its files; the default collapses it to the
 * directory name, which `update-index --add` cannot stage.
 */
async function dirtyPaths(worktreePath: string): Promise<string[]> {
  const out = await runGit(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])
  const paths: string[] = []
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue
    // Porcelain v1: `XY <path>` or `XY <old> -> <new>` for renames. Take the
    // destination path of a rename — that is the file present on disk.
    const body = line.slice(3)
    const arrow = body.indexOf(' -> ')
    const raw = arrow >= 0 ? body.slice(arrow + 4) : body
    // A path with special characters comes back quoted; unquote it so the value
    // matches what `update-index` expects.
    paths.push(raw.startsWith('"') ? JSON.parse(raw) as string : raw)
  }
  return paths
}

/**
 * Capture the worktree's uncommitted state onto a recovery ref in the parent
 * repo, returning what was written.
 *
 * A clean worktree returns `nothingToPreserve` and writes no ref: an empty
 * snapshot is noise the operator would have to reason about later.
 */
export async function writeRecoveryRef(opts: {
  repoPath: string
  worktreePath: string
  branchName: string
}): Promise<RecoveryResult> {
  const { repoPath, worktreePath, branchName } = opts
  log('snapshot: starting', { repo_path: repoPath, worktree_path: worktreePath, branch: branchName })

  let paths: string[]
  try {
    paths = await dirtyPaths(worktreePath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Cannot enumerate what would be lost, so cannot promise it is safe.
    warn('snapshot: could not read worktree status', { worktree_path: worktreePath, error: msg })
    return { error: `Could not read the worktree's state to preserve it: ${msg}` }
  }

  if (paths.length === 0) {
    log('snapshot: worktree clean, nothing to preserve', { worktree_path: worktreePath })
    return { nothingToPreserve: true }
  }

  // Declared outside the try so the `finally` can remove it on every path.
  // Git never cleans up a GIT_INDEX_FILE — the creator owns it — and the name
  // carries a timestamp, so without this each forced retire of a dirty worktree
  // would leave another orphan index in .git/ forever.
  let tempIndex: string | undefined

  try {
    // A temporary index inside the repo's own .git so it shares a filesystem
    // with the object store, and so a crash leaves nothing in the worktree.
    const gitDir = (await runGit(repoPath, ['rev-parse', '--absolute-git-dir'])).trim()
    tempIndex = `${gitDir}/ion-recovery-index-${Date.now()}`
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex }

    // Seed the temp index from the worktree's HEAD so the snapshot commit is a
    // full tree (HEAD content plus the dirty paths), not just the dirty files.
    await runGit(worktreePath, ['read-tree', 'HEAD'], env)
    await runGit(worktreePath, ['update-index', '--add', '--remove', '--', ...paths], env)
    const tree = (await runGit(worktreePath, ['write-tree'], env)).trim()

    const head = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).trim()
    const message = [
      `ion: recovery snapshot for ${branchName}`,
      '',
      'Written automatically before a force-retire removed this worktree.',
      `Worktree: ${worktreePath}`,
      `Files preserved: ${paths.length}`,
      '',
      'Recover with:',
      `  git checkout -b recovered-${branchName.replace(/^wt\//, '')} <this-commit>`,
    ].join('\n')
    const sha = (await runGit(worktreePath, ['commit-tree', tree, '-p', head, '-m', message], env)).trim()

    // Ref name carries the branch and a timestamp so repeated retires of
    // similarly-named branches never collide and the ordering is readable.
    const slug = branchName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree'
    const ref = `${RECOVERY_REF_PREFIX}/${slug}-${Math.floor(Date.now() / 1000)}`
    // Written in the PARENT repo: the worktree directory is about to be deleted,
    // and a ref is only useful if it outlives it.
    await runGit(repoPath, ['update-ref', ref, sha])

    log('snapshot: written', {
      repo_path: repoPath,
      worktree_path: worktreePath,
      branch: branchName,
      ref,
      sha,
      files: paths.length,
    })
    return { snapshot: { ref, sha, paths } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn('snapshot: failed', { worktree_path: worktreePath, branch: branchName, error: msg })
    return { error: `Could not preserve the worktree's uncommitted work: ${msg}` }
  } finally {
    if (tempIndex) {
      // The snapshot commit and its ref are already durable in the object store
      // by this point, so losing the scratch index costs nothing. A failure to
      // unlink is logged rather than thrown: it must never turn a written
      // snapshot into a reported failure, which would refuse the retire and
      // keep a worktree the operator asked to remove.
      try {
        rmSync(tempIndex, { force: true })
        log('snapshot: temp index removed', { temp_index: tempIndex })
      } catch (err) {
        warn('snapshot: temp index left behind', { temp_index: tempIndex, error: String(err) })
      }
    }
  }
}
