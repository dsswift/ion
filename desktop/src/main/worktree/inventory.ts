/**
 * Worktree inventory — the answer to "what worktrees exist here, and how do I
 * get back into one?"
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * Closing a worktree conversation used to be a trap. `closeTab` force-removed
 * the worktree, so an accidental close destroyed the work outright. Even once
 * close stops destroying anything (it does now — see the close guard), the
 * conversation is gone and there is no history feature to recover it. The only
 * way back in was to create a tab and manually browse to a path like
 * `~/.ion/worktrees/ion-a3f1` that the operator has no reason to know.
 *
 * So the worktree has to be *discoverable*: list what exists for this repo,
 * with enough state to tell them apart, and let the operator open a fresh
 * conversation directly into one. That is strictly better than forbidding close,
 * which would pin the operator to a single immortal conversation per worktree.
 *
 * The durable per-worktree record (source branch, base, title, stage,
 * landedAt) lives in registry.ts; this module owns the live git crawl that
 * joins those records onto what `git worktree list` reports, and re-exports
 * the registry surface so existing import paths keep working.
 */
import { log as _log, warn as _warn } from '../logger'
import { runGit } from '../git-runner'
import { parseWorktreeList } from './integrate'
import {
  appraiseRefPair, commitSubject, pruneAppraisalCache, type AppraisalCounters,
} from './inventory-appraise'
import { getProvisionState } from './provision-state'
import { probeOperationState } from '../git/operation-state'
import {
  lookupSourceBranch, lookupWorktreeTitle, lookupWorktreeLandedAt, lookupWorktreeStage,
} from './registry'
import type { WorktreeInventoryEntry } from '../../shared/types'

const TAG = 'worktree.inventory'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

// The registry (the durable per-worktree record: source branch, base, title,
// stage, landedAt) lives in registry.ts — extracted at the record/crawl seam
// for the file-size cap. Re-exported here so existing import paths keep
// working; this module owns the live git crawl that joins those records onto
// what `git worktree list` reports.
export {
  worktreeRegistryFile,
  registerWorktree,
  markWorktreeLanded,
  setWorktreeTitle,
  lookupWorktreeTitle,
  setWorktreeStage,
  advanceWorktreeStageOnPinChange,
  lookupWorktreeStage,
  lookupWorktreeLandedAt,
  lookupWorktreeRegistration,
  unregisterWorktree,
  lookupSourceBranch,
  lookupWorktreeBase,
  setWorktreeBase,
} from './registry'

/**
 * One worktree, with everything the UI needs to describe and act on it.
 *
 * Re-exported from `shared/types-git` rather than declared here. This used to be
 * a second, hand-maintained copy of the same shape; two declarations of one wire
 * contract drift the moment a field is added to only one of them (which is
 * exactly what happened when `provisionState` was introduced). The shared file
 * is the single definition, and this export keeps the existing import paths in
 * this package working.
 */
export type { WorktreeInventoryEntry } from '../../shared/types'

/**
 * List every managed worktree for a repo, enriched with the state needed to
 * pick one and act on it. Read-only.
 *
 * The bench worktree and the repo's own root are excluded: they are not feature
 * worktrees and offering them here would be misleading.
 *
 * ── Crawl budget ────────────────────────────────────────────────────────────
 * This is the desktop's most-repeated git surface (two windows poll it while
 * the panel is open, plus the iOS projection), so its subprocess count is a
 * first-class property: two fixed spawns (`worktree list`, `for-each-ref`)
 * plus one `status --porcelain` per worktree, with the land-relative facts
 * answered by the sha-keyed cache in inventory-appraise.ts (zero spawns until
 * a ref actually moves). It previously ran ~8 spawns per worktree per crawl,
 * which is what let overlapping crawls freeze the overlay. Callers should
 * reach this through inventory-service.ts, which coalesces concurrent crawls.
 */
export async function inventoryWorktrees(
  repoPath: string,
): Promise<WorktreeInventoryEntry[]> {
  return (await inventoryWorktreesDetailed(repoPath)).entries
}

/**
 * The crawl result plus the identity facts the caching service needs:
 * `git worktree list` answers identically from ANY checkout of the repo, so
 * every listed path is an alias for the same inventory and the MAIN worktree
 * (always listed first) is its canonical cache key.
 */
export interface WorktreeInventoryResult {
  /** The repo's main working-tree path, or null when the listing failed. */
  canonicalRepoPath: string | null
  /** Every listed checkout path (main, bench, features) — the alias set. */
  aliasPaths: string[]
  entries: WorktreeInventoryEntry[]
}

/** `inventoryWorktrees` with the canonical/alias identity attached. */
export async function inventoryWorktreesDetailed(
  repoPath: string,
): Promise<WorktreeInventoryResult> {
  const startedAt = Date.now()
  let listed: ReturnType<typeof parseWorktreeList>
  try {
    listed = parseWorktreeList(await runGit(repoPath, ['worktree', 'list', '--porcelain']))
  } catch (err) {
    warn('could not list worktrees', { repo_path: repoPath, error: String(err) })
    return { canonicalRepoPath: null, aliasPaths: [], entries: [] }
  }

  // Every source branch's tip in one spawn. A worktree whose source branch is
  // missing from this map gets no land-relative answers and fails CLOSED on
  // `safeToDiscard` — same contract as the appraisal it replaces.
  const branchTips = new Map<string, string>()
  try {
    const raw = await runGit(repoPath, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])
    for (const line of raw.split('\n')) {
      const sep = line.lastIndexOf(' ')
      if (sep > 0) branchTips.set(line.slice(0, sep), line.slice(sep + 1).trim())
    }
  } catch (err) {
    warn('could not read branch tips; land-relative facts will fail closed', {
      repo_path: repoPath, error: String(err),
    })
  }

  const counters: AppraisalCounters = { hits: 0, misses: 0 }
  const entries: WorktreeInventoryEntry[] = []
  for (const [index, wt] of listed.entries()) {
    // Skip the repo's main working tree and the integration bench: neither is
    // a feature worktree, and offering them navigates the operator to the
    // wrong place. Git guarantees the MAIN worktree is listed first, which is
    // the identity check that holds no matter which checkout ran the query.
    // The previous check compared against `repoPath` — but this inventory is
    // also queried from inside a worktree or bench tab, where `repoPath` is
    // that checkout's own path: the main clone slipped through as a stray row,
    // and a worktree would have dropped ITSELF from its own panel.
    if (index === 0) continue
    if (wt.branch.startsWith('ion/bench/')) continue

    // A detached HEAD is usually not a managed feature worktree — but a
    // conflicted rebase detaches HEAD too, and dropping the entry in that state
    // made two mid-rebase worktrees vanish from the panel at the exact moment
    // the operator needed to see them. Probe for an in-progress operation and
    // recover the branch git recorded (rebase-merge/head-name) before skipping.
    let branchName = wt.branch
    const landedAt = lookupWorktreeLandedAt(wt.path)
    const operation = landedAt == null
      ? await probeOperationState(wt.path)
      : { state: undefined, branch: undefined, conflictedPaths: [] as string[] }
    if (!branchName) {
      if (operation.state && operation.branch) {
        branchName = operation.branch
        log('recovered mid-operation worktree', {
          worktree_path: wt.path,
          branch: branchName,
          operation: operation.state,
          conflicted: operation.conflictedPaths.length,
        })
      } else {
        // Genuinely detached (operator checkout, bisect artifact) — not ours.
        log('skipping detached worktree with no recorded operation', { worktree_path: wt.path })
        continue
      }
    }

    const sourceBranch = lookupSourceBranch(wt.path)
    const title = lookupWorktreeTitle(wt.path)
    const stage = lookupWorktreeStage(wt.path)

    // Subject is a pure function of the HEAD sha, so it caches under it. A
    // listing entry without a HEAD (prunable/broken checkout) has no commit to
    // describe — skip the lookup rather than handing git an empty sha.
    const lastCommitSubject = landedAt != null || !wt.head
      ? ''
      : await commitSubject(wt.path, wt.head)

    // Landed is terminal: the work is on the source branch. Skip every git
    // probe (isDirty, appraiseRefPair, probeOperationState was already run but
    // its result is conservative-safe) and report known-terminal values.
    let unlandedCommitCount = 0
    let safeToDiscard = false
    let needsSync = false
    let isDirty = false
    if (landedAt != null) {
      safeToDiscard = true
    } else if (!operation.state) {
      // Without a known source branch the land-relative facts are unanswerable.
      // Report what IS knowable and leave the rest conservative. A mid-operation
      // worktree also skips the appraisals: unlanded counts and needsSync are
      // meaningless halfway through a rebase, and their git reads can fail — the
      // operation itself is the state worth reporting.
      try {
        isDirty = (await runGit(wt.path, ['status', '--porcelain', '-uall'])).trim().length > 0
      } catch (err) {
        log('could not read status', { worktree_path: wt.path, error: String(err) })
      }

      const sourceTip = sourceBranch ? branchTips.get(sourceBranch) : undefined
      if (sourceBranch && sourceTip && wt.head) {
        const pair = await appraiseRefPair(wt.path, wt.head, sourceTip, counters)
        if (pair) {
          unlandedCommitCount = pair.ahead
          safeToDiscard = !isDirty && pair.ahead === 0
          needsSync = pair.behind > 0 && pair.treesDiffer
        }
      }
    }

    // Provisioning state is per-run and lives in memory, so a worktree with no
    // record (created before provisioning existed, or before a restart) simply
    // omits the field rather than claiming a state it cannot know.
    const provision = getProvisionState(wt.path)

    entries.push({
      worktreePath: wt.path,
      branchName,
      label: wt.path.split('/').filter(Boolean).pop() || branchName,
      title: title ?? undefined,
      sourceBranch,
      head: wt.head.slice(0, 7),
      lastCommitSubject,
      isDirty,
      unlandedCommitCount,
      needsSync,
      safeToDiscard,
      landedAt: landedAt ?? undefined,
      stage: stage ?? undefined,
      operationState: operation.state,
      conflictedPaths: operation.conflictedPaths.length > 0 ? operation.conflictedPaths : undefined,
      provisionState: provision?.state,
      provisionError: provision?.error,
    })
  }

  // Retired paths must not pin cached appraisals.
  pruneAppraisalCache(new Set(listed.map((w) => w.path)))

  const durationMs = Date.now() - startedAt
  log('inventoried worktrees', {
    repo_path: repoPath,
    count: entries.length,
    duration_ms: durationMs,
    appraisal_cache_hits: counters.hits,
    appraisal_cache_misses: counters.misses,
  })
  if (durationMs > 2000) {
    warn('inventory crawl slow', { repo_path: repoPath, duration_ms: durationMs, count: entries.length })
  }

  return {
    canonicalRepoPath: listed[0]?.path ?? null,
    aliasPaths: listed.map((w) => w.path),
    entries,
  }
}
