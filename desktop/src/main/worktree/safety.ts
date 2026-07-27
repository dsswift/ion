/**
 * Worktree data-safety appraisal — the single authority on whether removing a
 * worktree would destroy work.
 *
 * ── The defect this exists to prevent ───────────────────────────────────────
 * Closing a tab called `gitWorktreeRemove(..., force=true)` unconditionally,
 * and the remove handler then ran `git branch -D`. Together that destroyed,
 * with no prompt and no recovery:
 *
 *   - uncommitted changes in the worktree (gone with the directory), and
 *   - committed-but-unlanded commits (unreachable after the forced branch
 *     delete, so `git worktree list` / `branch` show nothing to recover from).
 *
 * A `--force` remove plus `branch -D` is an unrecoverable pair. Data loss here
 * is not an edge case: the normal parallel-development flow leaves worktrees
 * with commits that have not landed yet.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Nothing destroys a worktree without first appraising it. The appraisal is a
 * pure inspection with no side effects, so it is safe to run on any path, and
 * it FAILS CLOSED: if the state cannot be determined, the verdict is "unsafe"
 * and the caller must confirm or refuse. Never assume clean.
 *
 * Deliberately NOT a heuristic: "was anything written recently", "does the tab
 * look done", "did the agent say it committed". The appraisal asks git.
 */
import { execFile } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'

const execFileAsync = promisify(execFile)

/**
 * Run git with an ISOLATED index file, so staging operations never touch the
 * worktree's real index. This is what makes capturing uncommitted work safe on
 * a worktree an agent is still using.
 */
async function runGitWithIndex(cwd: string, indexFile: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(e.stderr?.trim() || e.message || String(err))
  }
}

const TAG = 'worktree.safety'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** What a worktree would lose if it were removed right now. */
export interface WorktreeAppraisal {
  /** Uncommitted tracked modifications, staged changes, or untracked files. */
  hasUncommittedChanges: boolean
  /** Paths with uncommitted state (capped for display). */
  uncommittedPaths: string[]
  /**
   * Commits on this branch that are NOT reachable from the source branch —
   * i.e. work that would become unreachable if the branch were deleted.
   */
  unlandedCommitCount: number
  /** Subjects of the unlanded commits (capped for display). */
  unlandedSubjects: string[]
  /** True when the branch's commits are all contained in the source branch. */
  fullyLanded: boolean
  /**
   * True when removing this worktree destroys nothing recoverable.
   * FAILS CLOSED: false whenever the appraisal could not be completed.
   */
  safeToDiscard: boolean
  /** Human-readable reason when `safeToDiscard` is false. */
  reason?: string
  /** Set when the appraisal itself failed (worktree unreadable, git error). */
  appraisalFailed?: boolean
}

/** Cap on the number of paths/subjects reported, so a huge diff stays readable. */
const DISPLAY_CAP = 20

/**
 * Inspect a worktree and report exactly what removing it would cost.
 *
 * Read-only: runs only `status`, `rev-list`, and `log`. Safe to call from any
 * path, including one that will not remove anything.
 */
export async function appraiseWorktree(
  worktreePath: string,
  sourceBranch: string,
): Promise<WorktreeAppraisal> {
  // Fail-closed default. Every early return below is a REFUSAL to declare the
  // worktree safe, never an assumption that it is.
  const unknown: WorktreeAppraisal = {
    hasUncommittedChanges: false,
    uncommittedPaths: [],
    unlandedCommitCount: 0,
    unlandedSubjects: [],
    fullyLanded: false,
    safeToDiscard: false,
    reason: 'Could not determine what this worktree contains, so it is not safe to discard.',
    appraisalFailed: true,
  }

  let uncommittedPaths: string[]
  try {
    const status = await runGit(worktreePath, ['status', '--porcelain', '-uall'])
    uncommittedPaths = status
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
  } catch (err) {
    warn('appraisal failed reading status', { worktree_path: worktreePath, error: String(err) })
    return unknown
  }

  let unlandedSubjects: string[] = []
  let unlandedCommitCount = 0
  try {
    // Commits on HEAD not reachable from the source branch. This is the exact
    // question "what would `branch -D` make unreachable".
    const raw = await runGit(worktreePath, ['log', '--format=%s', `${sourceBranch}..HEAD`])
    unlandedSubjects = raw.split('\n').map((s) => s.trim()).filter(Boolean)
    unlandedCommitCount = unlandedSubjects.length
  } catch (err) {
    // A missing source branch means we cannot know what has landed. Refuse
    // rather than treating "no answer" as "nothing to lose".
    warn('appraisal failed reading unlanded commits', {
      worktree_path: worktreePath,
      source_branch: sourceBranch,
      error: String(err),
    })
    return unknown
  }

  const hasUncommittedChanges = uncommittedPaths.length > 0
  const fullyLanded = unlandedCommitCount === 0
  const safeToDiscard = !hasUncommittedChanges && fullyLanded

  const reasons: string[] = []
  if (hasUncommittedChanges) {
    reasons.push(`${uncommittedPaths.length} uncommitted file${uncommittedPaths.length === 1 ? '' : 's'}`)
  }
  if (!fullyLanded) {
    reasons.push(`${unlandedCommitCount} commit${unlandedCommitCount === 1 ? '' : 's'} not yet landed in ${sourceBranch}`)
  }

  const appraisal: WorktreeAppraisal = {
    hasUncommittedChanges,
    uncommittedPaths: uncommittedPaths.slice(0, DISPLAY_CAP),
    unlandedCommitCount,
    unlandedSubjects: unlandedSubjects.slice(0, DISPLAY_CAP),
    fullyLanded,
    safeToDiscard,
    reason: reasons.length > 0 ? `This worktree has ${reasons.join(' and ')}.` : undefined,
  }

  log('appraised worktree', {
    worktree_path: worktreePath,
    source_branch: sourceBranch,
    uncommitted: uncommittedPaths.length,
    unlanded: unlandedCommitCount,
    safe_to_discard: safeToDiscard,
  })
  return appraisal
}

/**
 * Rescue an at-risk worktree's work before it is destroyed, by leaving a
 * recoverable trace in the repository.
 *
 * This is the counterpart to fail-closed appraisal: when the operator DOES
 * choose to discard, the work still does not vanish irretrievably.
 *
 *   - Uncommitted changes are captured as a dangling commit via `stash create`
 *     (which does NOT touch the worktree or the stash list) and then anchored
 *     by a real ref so gc cannot reclaim it.
 *   - The branch tip is anchored the same way, so `branch -D` cannot make
 *     unlanded commits unreachable.
 *
 * Both anchors are ordinary refs under `refs/ion/discarded/`, greppable with
 * `git for-each-ref refs/ion/discarded` and restorable with a normal checkout.
 * Returns the refs created so the caller can tell the operator where the work
 * went.
 */
export async function preserveWorktreeWork(
  repoPath: string,
  worktreePath: string,
  branchName: string,
): Promise<{ refs: string[]; error?: string }> {
  const refs: string[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeBranch = branchName.replace(/[^a-zA-Z0-9._-]+/g, '-')

  // 1. The branch tip — protects committed-but-unlanded work from `branch -D`.
  try {
    const head = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).trim()
    const ref = `refs/ion/discarded/${safeBranch}/${stamp}/head`
    await runGit(repoPath, ['update-ref', ref, head])
    refs.push(ref)
    log('preserved branch tip', { ref, sha: head.slice(0, 7) })
  } catch (err) {
    warn('could not preserve branch tip', { worktree_path: worktreePath, error: String(err) })
    return { refs, error: `Could not preserve the branch tip: ${String(err)}` }
  }

  // 2. Uncommitted changes — captured through a THROWAWAY index so the
  //    worktree, its real index, and the stash list are all left alone.
  //
  //    `git stash create` is the obvious tool and is NOT sufficient: it ignores
  //    untracked files entirely and returns an empty sha when untracked files
  //    are the only uncommitted work. A worktree whose new files had never been
  //    added would have been reported as "preserved" while its actual content
  //    was silently dropped. `add -A` against a temp index captures tracked
  //    modifications, staged changes, and untracked files alike, while still
  //    honouring .gitignore so build output is not archived.
  const tmpDir = mkdtempSync(join(tmpdir(), 'ion-preserve-idx-'))
  const indexFile = join(tmpDir, 'index')
  try {
    const head = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).trim()
    await runGitWithIndex(worktreePath, indexFile, ['read-tree', 'HEAD'])
    await runGitWithIndex(worktreePath, indexFile, ['add', '-A'])
    const tree = (await runGitWithIndex(worktreePath, indexFile, ['write-tree'])).trim()
    const headTree = (await runGit(worktreePath, ['rev-parse', 'HEAD^{tree}'])).trim()

    if (tree === headTree) {
      log('no uncommitted changes to preserve', { worktree_path: worktreePath })
    } else {
      const sha = (await runGit(worktreePath, [
        'commit-tree', tree, '-p', head, '-m', 'ion: preserved uncommitted work before discard',
      ])).trim()
      const ref = `refs/ion/discarded/${safeBranch}/${stamp}/uncommitted`
      await runGit(repoPath, ['update-ref', ref, sha])
      refs.push(ref)
      log('preserved uncommitted changes', { ref, sha: sha.slice(0, 7) })
    }
  } catch (err) {
    // The branch tip is already anchored, so this is a partial success worth
    // reporting rather than a total failure.
    warn('could not preserve uncommitted changes', { worktree_path: worktreePath, error: String(err) })
    return { refs, error: `Preserved the branch tip but not the uncommitted changes: ${String(err)}` }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch (err) {
      log('temp index cleanup failed', { dir: tmpDir, error: String(err) })
    }
  }

  return { refs }
}

/**
 * List preserved-work refs, so the operator can find rescued work without
 * knowing the ref convention.
 */
export async function listPreservedWork(repoPath: string): Promise<Array<{ ref: string; sha: string; subject: string }>> {
  try {
    const raw = await runGit(repoPath, [
      'for-each-ref', '--format=%(refname)%09%(objectname)%09%(contents:subject)', 'refs/ion/discarded',
    ])
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, sha, subject] = line.split('\t')
        return { ref, sha, subject: subject || '' }
      })
  } catch (err) {
    warn('could not list preserved work', { repo_path: repoPath, error: String(err) })
    return []
  }
}
