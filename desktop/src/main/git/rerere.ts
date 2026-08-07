/**
 * git rerere — enable resolution recording for a repository.
 *
 * Shared by the bench assembly (bench-assemble.ts) and the worktree sync verb
 * (worktree/integrate.ts). Extracted so the sync path does not depend on a
 * bench assembly having run first: rerere must be active before the FIRST
 * conflicted rebase in any worktree, or that conflict neither replays an
 * existing recording nor records a new one.
 *
 * Recordings live in the MAIN repo's `$GIT_COMMON_DIR/rr-cache`, keyed by
 * conflict text — linked worktrees share it, so a resolution recorded while
 * completing one worktree's rebase replays in every sibling worktree that hits
 * the same conflict. That sharing is the entire economics of the parallel
 * workflow: a dozen worktrees rebasing onto the same new source tip hit
 * largely identical conflicts, and one recording clears the rest.
 */
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'git.rerere'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Enable `git rerere` for the repository that hosts `directory`.
 *
 * Repo-local (`--local` is the default scope for `git config` writes), set on
 * any checkout but stored in the shared common dir, so every worktree of the
 * repo — including the operator's own manual rebases — records and replays
 * resolutions. `rerere.autoUpdate` also STAGES a replayed path, which is what
 * lets a caller complete a fully replayed merge or rebase without hand-adding
 * files.
 *
 * Idempotent and cheap (two config writes), so callers run it before every
 * operation rather than tracking a "configured once" flag that could go stale
 * when the repo's config is wiped.
 */
export async function ensureRerereEnabled(directory: string): Promise<void> {
  try {
    await runGit(directory, ['config', 'rerere.enabled', 'true'])
    await runGit(directory, ['config', 'rerere.autoUpdate', 'true'])
    log('rerere enabled for repository', { directory })
  } catch (err) {
    // The caller's operation still works without rerere — conflicts just
    // always need a fresh resolution — so this degrades rather than fails.
    warn('could not enable rerere', { directory, error: String(err) })
  }
}
