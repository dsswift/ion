/**
 * Sync All — the bulk mechanical pass over every worktree of a repo.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The parallel workflow's worst moment is "the source branch moved": a dozen
 * worktrees go base-stale at once, and the single-row Sync verb makes the
 * operator click, wait, and triage twelve times for rebases that are largely
 * identical. This module runs the whole board in one verb.
 *
 * ── Sequential on purpose ───────────────────────────────────────────────────
 * Worktrees are processed one at a time, not in parallel. Two reasons, both
 * load-bearing:
 *   1. Rerere cascade: each completed rebase RECORDS its conflict resolutions
 *      into the repo's shared rr-cache, and each later rebase REPLAYS them.
 *      Sequential order is what lets worktree #1's resolution clear the
 *      identical conflict in worktrees #2..#12 for free. Parallel rebases
 *      would each hit the conflict before any recording exists.
 *   2. Ref safety: a dozen simultaneous rebases in linked worktrees of one
 *      repo contend on shared refs and the common dir.
 *
 * ── What each worktree gets ─────────────────────────────────────────────────
 *   - mid-rebase already → attempt replay-completion only (a recording made
 *     since it got stuck may cover it); never start a second operation.
 *   - needsSync, clean   → the full sync verb (precise base + rerere).
 *   - dirty              → typed skip. Never touched — the single-row verb
 *     refuses dirty trees and the bulk verb must not be more aggressive.
 *   - already current    → typed skip, so the summary accounts for every row.
 *
 * The pass never opens conversations or spends tokens: AI escalation is the
 * renderer pipeline's phase 2, gated behind operator confirmation. This
 * module is the free half.
 */
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { inventoryWorktrees } from './inventory'
import { syncWorktreeFromSource, completeRebaseIfReplayed } from './integrate'
import type { SyncAllResult, SyncAllWorktreeOutcome } from '../../shared/types'

const TAG = 'worktree.syncall'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Sync every managed worktree of `repoPath` from its own source branch.
 *
 * Serialized on the repo's mutation queue as ONE unit: a land or assembly
 * arriving mid-pass waits for the whole pass, and the pass never interleaves
 * with either. The per-worktree rebases inside are already sequential.
 */
export async function syncAllWorktrees(repoPath: string): Promise<SyncAllResult> {
  const repo = repositoryManager.get(repoPath)
  return repo.queue.enqueueMutation(() => syncAllWorktreesUnqueued(repoPath))
}

/**
 * The pass body without the queue wrapper. Exported for tests and for callers
 * already holding the repo mutation slot.
 */
export async function syncAllWorktreesUnqueued(repoPath: string): Promise<SyncAllResult> {
  const entries = await inventoryWorktrees(repoPath)
  log('sync-all: starting', { repo_path: repoPath, worktrees: entries.length })

  const outcomes: SyncAllWorktreeOutcome[] = []
  for (const entry of entries) {
    const base = {
      worktreePath: entry.worktreePath,
      branchName: entry.branchName,
      title: entry.title,
    }

    // A landed worktree's work is already in the source branch; its checkout
    // is a leftover awaiting retire, and rebasing it buys nothing.
    if (entry.landedAt) {
      outcomes.push({ ...base, outcome: 'skipped-clean' })
      continue
    }

    if (!entry.sourceBranch) {
      log('sync-all: skipping worktree with unknown source branch', { worktree_path: entry.worktreePath })
      outcomes.push({ ...base, outcome: 'skipped-unknown-source' })
      continue
    }

    if (entry.operationState) {
      // Already mid-operation (a conflicted sync from before, a manual
      // rebase). Do not start anything new — but a resolution recorded since
      // it got stuck may cover it, so attempt the free completion.
      if (entry.operationState !== 'rebasing') {
        log('sync-all: worktree mid non-rebase operation, leaving as-is', {
          worktree_path: entry.worktreePath, operation: entry.operationState,
        })
        outcomes.push({ ...base, outcome: 'conflicted', conflictedPaths: entry.conflictedPaths })
        continue
      }
      const completion = await completeRebaseIfReplayed(entry.worktreePath)
      if (completion.completed) {
        log('sync-all: stranded rebase completed by replay', { worktree_path: entry.worktreePath })
        outcomes.push({ ...base, outcome: 'replayed' })
      } else {
        outcomes.push({
          ...base,
          outcome: 'conflicted',
          conflictedPaths: completion.conflictedPaths,
          error: completion.error,
        })
      }
      continue
    }

    if (entry.isDirty) {
      // Same rule as the single-row verb: uncommitted work is never touched.
      outcomes.push({ ...base, outcome: 'skipped-dirty' })
      continue
    }

    if (!entry.needsSync) {
      outcomes.push({ ...base, outcome: 'skipped-clean' })
      continue
    }

    const result = await syncWorktreeFromSource(entry.worktreePath, entry.sourceBranch)
    if (result.ok) {
      outcomes.push({
        ...base,
        outcome: result.replayed ? 'replayed' : 'synced',
        dropped: result.dropped,
      })
    } else if (result.hasConflicts) {
      let conflictedPaths: string[] | undefined
      try {
        const raw = await runGit(entry.worktreePath, ['diff', '--name-only', '--diff-filter=U'])
        conflictedPaths = raw.split('\n').map((p) => p.trim()).filter(Boolean)
      } catch (err) {
        log('sync-all: could not list conflicted paths', { worktree_path: entry.worktreePath, error: String(err) })
      }
      outcomes.push({ ...base, outcome: 'conflicted', conflictedPaths, error: result.error })
    } else if (result.refusedDirty) {
      // The inventory said clean but the tree dirtied between the read and the
      // sync (an agent committing, a build writing). The refusal is the truth.
      outcomes.push({ ...base, outcome: 'skipped-dirty' })
    } else {
      outcomes.push({ ...base, outcome: 'failed', error: result.error })
    }
  }

  const count = (o: SyncAllWorktreeOutcome['outcome']): number =>
    outcomes.filter((x) => x.outcome === o).length
  const summary = {
    synced: count('synced'),
    replayed: count('replayed'),
    conflicted: count('conflicted'),
    skippedDirty: count('skipped-dirty'),
    skippedClean: count('skipped-clean'),
    skippedUnknownSource: count('skipped-unknown-source'),
    failed: count('failed'),
    dropped: outcomes.reduce((total, x) => total + (x.dropped ?? 0), 0),
  }
  const anyProblem = summary.conflicted > 0 || summary.failed > 0
  ;(anyProblem ? warn : log)('sync-all: done', { repo_path: repoPath, ...summary })

  return { ok: true, outcomes, summary }
}
