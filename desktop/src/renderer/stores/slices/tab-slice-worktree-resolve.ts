/**
 * Worktree resolution for tab creation — decide WHERE a new conversation will
 * live before anything is started in it.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * Three call sites used to carry their own copy of this logic (`createTab`,
 * `createTabInDirectory`, and the `setBaseDirectory` follow-up in
 * directory-slice). Three copies of "probe the repo, look up the branch default,
 * add a worktree" is three chances to diverge, and they did: only one of them
 * resolved BEFORE the engine session was started.
 *
 * That divergence was the bug. `createTabInDirectory` created the tab (which
 * eagerly starts an engine session in the directory it was given), and only
 * afterward created the worktree and patched renderer state. The engine pins a
 * session's working directory at `start_session`, so the session stayed in the
 * base repo while the UI showed the worktree — and five conversations ended up
 * sharing one checkout.
 *
 * Resolution is therefore a PURE PRE-STEP: it runs before tab creation, and its
 * answer is the directory the tab is born with. Nothing downstream has to
 * relocate anything, because nothing was ever started in the wrong place.
 *
 * ── Why the "pending" outcome exists ────────────────────────────────────────
 * A repo with no recorded branch default cannot have a worktree cut for it
 * without asking the operator which branch to cut from. That question is UI, not
 * resolution, so this module reports `pendingSetup: true` and the caller marks
 * the tab for the branch picker (TabStrip completes it via `setupWorktree`).
 */
import { usePreferencesStore } from '../../preferences'
import { rInfo, rWarn } from '../../rendererLogger'
import type { WorktreeInfo } from '../../../shared/types'

export interface WorktreeResolution {
  /**
   * The directory the tab should be created in. Equal to the requested `dir`
   * unless a worktree was successfully created, in which case it is the
   * worktree path.
   */
  dir: string
  /** Set when a worktree was created for this tab. */
  worktree: WorktreeInfo | null
  /**
   * True when a worktree was requested for a repo with no recorded branch
   * default, so the operator still has to pick a source branch.
   */
  pendingSetup: boolean
}

/**
 * Resolve the working directory for a new conversation in `dir`.
 *
 * When `useWorktree` is false, or `dir` is not a git repo, this is a no-op that
 * returns `dir` unchanged — a non-repo directory has no worktrees to cut and an
 * unrequested worktree must never be created implicitly.
 *
 * Every outcome logs: which branch a worktree was cut from, why resolution was
 * skipped, or why it fell through to the branch picker. A silent fallthrough
 * here would reproduce the original defect's worst property — a conversation
 * running somewhere other than where the operator believes.
 */
export async function resolveWorktreeForNewTab(
  dir: string,
  useWorktree: boolean | undefined,
): Promise<WorktreeResolution> {
  const unchanged: WorktreeResolution = { dir, worktree: null, pendingSetup: false }

  if (!useWorktree) return unchanged

  let isRepo = false
  try {
    isRepo = (await window.ion.gitIsRepo(dir)).isRepo
  } catch (err) {
    // Fail OPEN as "no worktree": the operator asked for a conversation and
    // should get one in the requested directory rather than an error. Logged at
    // warn because a failed probe on a directory that IS a repo silently costs
    // the operator their worktree isolation.
    rWarn('worktree.resolve', 'gitIsRepo probe failed; creating without a worktree', {
      dir, error: String(err),
    })
    return unchanged
  }

  if (!isRepo) {
    rInfo('worktree.resolve', 'not a git repo; creating without a worktree', { dir })
    return unchanged
  }

  const defaultBranch = usePreferencesStore.getState().worktreeBranchDefaults[dir]
  if (!defaultBranch) {
    rInfo('worktree.resolve', 'no branch default recorded; deferring to the branch picker', { dir })
    return { dir, worktree: null, pendingSetup: true }
  }

  try {
    const result = await window.ion.gitWorktreeAdd(dir, defaultBranch)
    if (result.ok && result.worktree) {
      rInfo('worktree.resolve', 'worktree created for a new conversation', {
        dir,
        source_branch: defaultBranch,
        worktree_path: result.worktree.worktreePath,
        branch: result.worktree.branchName,
      })
      return { dir: result.worktree.worktreePath, worktree: result.worktree, pendingSetup: false }
    }
    // Creation refused (dirty repo, bad branch, git error). Fall back to the
    // requested directory rather than the branch picker: the branch was known,
    // so re-asking for it would not help.
    rWarn('worktree.resolve', 'worktree creation refused; creating without a worktree', {
      dir, source_branch: defaultBranch, error: result.error ?? 'unknown',
    })
    return unchanged
  } catch (err) {
    rWarn('worktree.resolve', 'worktree creation threw; creating without a worktree', {
      dir, source_branch: defaultBranch, error: String(err),
    })
    return unchanged
  }
}
