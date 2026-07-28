/**
 * Member contribution — what a member contributes to the bench, and the tree
 * hash that identifies it.
 *
 * ── Only committed work integrates ──────────────────────────────────────────
 * A member contributes the tree of its branch HEAD. Uncommitted changes in a
 * worktree cannot reach the bench, and there is no mode that relaxes this.
 *
 * The reason is not convenience. A bench assembled from a half-saved working
 * tree represents a state that exists nowhere in history: it cannot be
 * reproduced, reviewed, bisected, or landed, and if its build fails there is
 * no commit to point at. Committing is the act by which the operator declares
 * a unit of work coherent — which is exactly the judgement the bench needs and
 * the engine cannot make. A change that needs a pair of commits to build is
 * integrated when the pair exists, not when the first half is saved to disk.
 *
 * An earlier iteration captured uncommitted work through a throwaway
 * `GIT_INDEX_FILE` so the member's index was never written. That machinery is
 * deliberately gone rather than left disabled: keeping it would leave a second
 * definition of "this member's content" for a mode that must not exist.
 *
 * ── Why tree hashes, not shas ───────────────────────────────────────────────
 * `contributedTreeHash` is the single definition of "this member's content".
 * Staleness compares trees rather than commit shas because a sha lies in both
 * directions: an amend or reword yields a new sha with an IDENTICAL tree (a
 * false stale that would offer an Update changing nothing), while a rebase
 * onto a moved source branch changes content with no new commit of the
 * operator's (a missed stale).
 */
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'
import type { IntegrationMember } from '../../shared/types'

const TAG = 'bench.snapshot'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** A member's contribution: the commit to merge and the tree identifying it. */
export interface Contribution {
  /** Commit the bench merges — the member branch's HEAD. */
  sha: string
  /** Tree hash — the content identity used for staleness. */
  treeHash: string
  /**
   * The merge base of `sha` and the source branch at the moment the pin was
   * taken. Together with `sha` this defines the contribution as a RANGE
   * (`baseSha..sha`) rather than a tip.
   *
   * That distinction is what separates "this member has not committed anything
   * yet" from "this member's work has landed". Both leave `pinnedSha` as an
   * ancestor of the source branch with an empty `sourceBranch..pinnedSha`, so no
   * question asked at rebuild time can tell them apart — the bench used to call
   * the first case landed and silently retire the member. When `baseSha` equals
   * `sha` the contribution is empty by construction, and that fact survives the
   * source branch moving underneath it.
   *
   * Empty when the merge base could not be read (a branch with no common
   * ancestor); callers treat that as "unknown", never as "empty".
   */
  baseSha: string
}

/**
 * Capture a worktree's contribution: its committed HEAD, that commit's tree, and
 * the merge base with the source branch. Read-only — nothing in the member
 * worktree is written.
 *
 * `sourceBranch` is required because the contribution is a range, and the range
 * is meaningless without the branch it is measured against.
 */
export async function captureContribution(
  worktreePath: string,
  sourceBranch: string,
): Promise<Contribution> {
  const sha = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).trim()
  const treeHash = (await runGit(worktreePath, ['rev-parse', 'HEAD^{tree}'])).trim()
  const baseSha = await mergeBaseWith(worktreePath, sha, sourceBranch)
  log('captured contribution', {
    worktree_path: worktreePath,
    sha: sha.slice(0, 7),
    tree: treeHash.slice(0, 7),
    base: baseSha ? baseSha.slice(0, 7) : 'unknown',
    source_branch: sourceBranch,
    // The single fact that decides whether this member has anything to merge.
    empty_contribution: baseSha !== '' && baseSha === sha,
  })
  return { sha, treeHash, baseSha }
}

/**
 * Merge base of `sha` and `sourceBranch`, or `''` when it cannot be determined.
 *
 * Returns empty rather than throwing: a member whose branch has no common
 * ancestor with the source branch is unusual but not a reason to fail the whole
 * enrollment, and the caller distinguishes unknown from empty.
 */
async function mergeBaseWith(
  worktreePath: string,
  sha: string,
  sourceBranch: string,
): Promise<string> {
  if (!sourceBranch) {
    log('no source branch, merge base not resolved', { worktree_path: worktreePath })
    return ''
  }
  try {
    return (await runGit(worktreePath, ['merge-base', sha, sourceBranch])).trim()
  } catch (err) {
    warn('could not resolve merge base with source branch', {
      worktree_path: worktreePath,
      source_branch: sourceBranch,
      error: String(err),
    })
    return ''
  }
}

/** True when the worktree has changes that are not committed. */
export async function hasUncommittedWork(worktreePath: string): Promise<boolean> {
  const status = await runGit(worktreePath, ['status', '--porcelain'])
  return status.trim().length > 0
}

/**
 * The tree hash a member currently contributes — the single definition of
 * "this member's content", used for staleness.
 *
 * Reads the member branch's committed HEAD, so uncommitted edits never mark a
 * member stale: there is nothing the operator could integrate from them.
 *
 * Returns null when the worktree or branch is gone (the `missing` case), which
 * the caller reports rather than treating as a change.
 */
export async function contributedTreeHash(member: IntegrationMember): Promise<string | null> {
  try {
    // Reads the tree directly rather than going through captureContribution:
    // staleness is a pure content question and needs no merge base, so asking for
    // one here would make the source branch a parameter of every staleness poll
    // for no gain.
    const treeHash = (await runGit(member.worktreePath, ['rev-parse', 'HEAD^{tree}'])).trim()
    log('read member tree hash', {
      worktree_path: member.worktreePath,
      branch: member.branchName,
      tree: treeHash.slice(0, 7),
    })
    return treeHash
  } catch (err) {
    warn('could not read member contribution', {
      worktree_path: member.worktreePath,
      branch: member.branchName,
      error: String(err),
    })
    return null
  }
}
