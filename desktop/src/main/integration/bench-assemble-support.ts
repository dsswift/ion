/**
 * Bench assembly support — worktree preparation, conflict attribution, and
 * the atomic-failure wipe.
 *
 * Split from bench-assemble.ts (file-size cap) at the seam between the
 * assembly LOOP (the deterministic reset-and-merge sequence) and the
 * mechanics that loop leans on before it starts and after it fails. None of
 * these three functions decide what merges; they prepare the ground and clean
 * up after a failure the loop has already detected.
 */
import { existsSync, mkdirSync } from 'fs'
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'
import { integrationRoot } from './bench-store'
import { parseWorktreeList } from '../worktree/integrate'
import type { IntegrationWorkspace, IntegrationMember } from '../../shared/types'

const TAG = 'bench.assemble'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Ensure the bench worktree exists and is registered with git.
 *
 * Self-healing: a bench directory deleted outside Ion is simply recreated on
 * the next assembly, because the durable state is the member set, not the tree.
 */
export async function ensureBenchWorktree(ws: IntegrationWorkspace): Promise<void> {
  const listed = parseWorktreeList(await runGit(ws.repoPath, ['worktree', 'list', '--porcelain']))
  const registered = listed.some((w) => w.path === ws.benchPath)

  if (registered && existsSync(ws.benchPath)) {
    log('bench worktree present', { bench_path: ws.benchPath })
    return
  }

  if (registered && !existsSync(ws.benchPath)) {
    // Registered but the directory is gone (deleted outside Ion). Prune the
    // stale registration so the add below succeeds.
    log('bench worktree registered but missing on disk, pruning', { bench_path: ws.benchPath })
    await runGit(ws.repoPath, ['worktree', 'prune'])
  }

  mkdirSync(integrationRoot(), { recursive: true })
  log('creating bench worktree', { bench_path: ws.benchPath, bench_branch: ws.benchBranch, source_branch: ws.sourceBranch })
  await runGit(ws.repoPath, ['worktree', 'add', '-B', ws.benchBranch, ws.benchPath, ws.sourceBranch])
}

/**
 * Reset the bench branch to a target tree, then remove any untracked file
 * that is NOT covered by .gitignore.
 *
 * `git reset --hard` resets tracked paths only (deliberately — ignored build
 * output like `node_modules/` must survive so an assembly stays incremental).
 * But a merge or rerere replay can leave a genuinely untracked, non-ignored
 * file behind when git's own abort logic refuses to delete a path it detects
 * local modifications on (rerere's `autoUpdate` is exactly such a modifier —
 * confirmed directly: `merge --abort` leaves an autoUpdate-staged file
 * untracked rather than removing it). That leftover then blocks every
 * subsequent merge that wants to write the same path, forever, because
 * nothing before this ever removed it — the exact loop that left a bench
 * permanently failing on a git error it never even surfaced (the merge fails
 * with ZERO unmerged paths, since it never reached conflict state at all).
 *
 * `git clean -fd` (no `-x`) removes exactly that class of file — untracked
 * and not ignored — while leaving every ignored path (node_modules, dist, Go
 * build caches) untouched, so incremental builds keep working exactly as
 * before. This is NOT `git clean -x`; ignored build output is never touched.
 *
 * Unconditional and unscoped is SAFE here specifically because the bench is
 * disposable by design (see bench-assemble.ts's module header: "the bench is
 * a pure function, never an accumulator" — every assembly recomputes it from
 * `(source tip, member list)` from scratch). Nothing durable is meant to live
 * in the bench outside what a rebuild reproduces. This is NOT the same
 * argument that would justify a blind clean in a member WORKTREE — a
 * worktree is the operator's durable working directory and may legitimately
 * hold untracked scratch content; see `git/untracked-obstruction.ts` for the
 * precise, git-named-paths mechanism that surface needs instead.
 */
export async function resetBenchToTree(benchPath: string, _benchBranch: string, target: string): Promise<void> {
  // The bench worktree remains on its dedicated branch for its lifetime. A hard
  // reset moves that branch and its tracked tree to the requested source tip
  // without `switch --discard-changes`, which removes ignored build artifacts
  // on Linux. Follow with clean -fd to remove only non-ignored obstructions.
  await runGit(benchPath, ['reset', '--hard', target])
  await runGit(benchPath, ['clean', '-fd'])
}

/**
 * Files left unmerged by a failed merge, and which earlier members touched them.
 *
 * ── Attribution asks about the RANGE, never the tip commit ──────────────────
 * The collision question is "does this member's CONTRIBUTION touch these
 * paths?", and a contribution is `pinnedBaseSha..pinnedSha` — the same range
 * the merge itself applies. This used to read `git show <pinnedSha>` (the tip
 * commit's file list), which is wrong for any member with more than one
 * commit: the live defect was a collider whose tip touched only a docs file
 * while an earlier commit in its range touched the conflicting path, so
 * attribution came back empty and the UI could name no counterpart. Same
 * mechanism and rationale as the engine's workspace-containment attribution.
 *
 * `pinnedBaseSha` can be empty on a legacy record; the bench's build base is
 * the honest fallback — every merged range is applied on top of it.
 */
export async function describeConflict(
  benchPath: string,
  mergedSoFar: IntegrationMember[],
  buildBaseSha: string,
  conflictedMember: IntegrationMember,
  sourceBranch: string,
): Promise<{ paths: string[]; conflictsWith: string[] }> {
  let paths: string[] = []
  try {
    const raw = await runGit(benchPath, ['diff', '--name-only', '--diff-filter=U'])
    paths = raw.split('\n').map((p) => p.trim()).filter(Boolean)
  } catch (err) {
    warn('could not list conflicting paths', { bench_path: benchPath, error: String(err) })
  }

  // Attribute the collision: which already-merged members' ranges touch these
  // files? Per-member try/catch so one unreadable range cannot lose the whole
  // attribution — the conflict report still fires, just with fewer names.
  const conflictsWith: string[] = []
  // Source attribution is separate from prior-member attribution. A single
  // enabled member can conflict because its source branch moved after its pin's
  // base. Name that real counterpart instead of returning an empty list.
  if (conflictedMember.pinnedBaseSha && conflictedMember.pinnedBaseSha !== buildBaseSha) {
    try {
      const touched = await runGit(benchPath, [
        'diff', '--name-only', conflictedMember.pinnedBaseSha, buildBaseSha,
      ])
      const touchedSet = new Set(touched.split('\n').map((path) => path.trim()).filter(Boolean))
      if (paths.some((path) => touchedSet.has(path))) conflictsWith.push(sourceBranch)
    } catch (err) {
      log('source conflict attribution skipped', {
        branch: conflictedMember.branchName,
        source_branch: sourceBranch,
        error: String(err),
      })
    }
  }

  for (const prior of mergedSoFar) {
    try {
      const base = prior.pinnedBaseSha || buildBaseSha
      const touched = await runGit(benchPath, ['diff', '--name-only', base, prior.pinnedSha])
      const touchedSet = new Set(touched.split('\n').map((p) => p.trim()).filter(Boolean))
      if (paths.some((p) => touchedSet.has(p))) conflictsWith.push(prior.branchName)
    } catch (err) {
      log('conflict attribution skipped for member', { branch: prior.branchName, error: String(err) })
    }
  }
  return { paths, conflictsWith }
}

/**
 * Wipe the bench to an empty tree after a failed assembly.
 *
 * The branch is pointed at a commit whose TREE is empty — created with the
 * well-known empty-tree object — and the working tree is reset to it. Tracked
 * files vanish; ignored build output (node_modules, caches) survives exactly
 * as it does across a normal assembly, so the next successful assembly still
 * builds incrementally. A terminal or conversation opened in the bench finds
 * nothing to falsely test, which is the whole point of atomicity: the bench
 * presents the enrolled combination or nothing.
 */
export async function wipeBenchToEmpty(ws: IntegrationWorkspace, reason: string): Promise<void> {
  try {
    // The canonical empty tree exists in every repo; hash-object makes the
    // dependency explicit rather than hardcoding the well-known sha.
    const emptyTree = (await runGit(ws.benchPath, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
    const commit = (await runGit(ws.benchPath, [
      'commit-tree', emptyTree, '-m', `ion-bench: assembly failed — ${reason}`,
    ])).trim()
    await runGit(ws.benchPath, ['reset', '--hard', commit])
    // Same untracked-leftover hazard the reset step guards against (see
    // resetBenchToTree's doc comment): `reset --hard` only clears
    // TRACKED files, so an untracked leftover from the failed merge/abort
    // this wipe is responding to would otherwise survive into the "empty"
    // bench and go on to block the next assembly's reset in turn.
    await runGit(ws.benchPath, ['clean', '-fd'])
    log('bench wiped to empty tree after failed assembly', {
      bench_path: ws.benchPath,
      bench_branch: ws.benchBranch,
      reason,
    })
  } catch (err) {
    // The wipe failing leaves the bench at the last merged state, which is the
    // partial bench atomicity exists to prevent — loud, not fatal: the failure
    // record still marks the assembly failed, so no UI claims success.
    warn('could not wipe bench after failed assembly', { bench_path: ws.benchPath, error: String(err) })
  }
}

/** What the merge-failure classifier decided, and the message it built. */
export interface MergeFailureClassification {
  failureKind: 'conflict' | 'obstructed'
  failureError: string
}

/**
 * Classify a failed member merge as a genuine content `'conflict'` or a
 * structural `'obstructed'` failure, and build the operator-facing message.
 *
 * ── The signal is structural, not a guess ────────────────────────────────────
 * A genuine content conflict ALWAYS produces at least one unmerged index
 * entry — that is what makes it a conflict rather than a clean merge or a
 * flat failure. `paths.length === 0` therefore means the merge failed WITHOUT
 * ever reaching conflict state at all: a preflight git refusal (an untracked,
 * non-ignored file blocking the write — the incident this classification was
 * added for), a filesystem error, anything that stops before the index is
 * touched. This is exact and version-independent, never a heuristic guess
 * based on matching error text.
 *
 * The obstructed message surfaces git's own error verbatim (`msg`) rather
 * than the old bare fallback that silently discarded it — the exact gap that
 * left an operator unable to tell what was wrong without reading raw logs.
 *
 * Extracted as its own function (rather than inlined in the assembly loop)
 * so the decision is directly unit-testable without needing a real git
 * failure to reach it — see bench-assemble-support.test.ts.
 */
export function classifyMergeFailure(
  branchName: string,
  paths: string[],
  conflictsWith: string[],
  msg: string,
): MergeFailureClassification {
  if (paths.length > 0) {
    return {
      failureKind: 'conflict',
      failureError: `${branchName} conflicts on ${paths.length} file${paths.length === 1 ? '' : 's'}`
        + `${conflictsWith.length > 0 ? ` with ${conflictsWith.join(', ')}` : ''}. `
        + 'The bench is empty until this is resolved.',
    }
  }
  return {
    failureKind: 'obstructed',
    failureError: `${branchName} could not be merged: ${msg.trim()}`,
  }
}
