/**
 * ephemeral-worktree-close — what closing a conversation does to the
 * ephemeral worktree it was cut for.
 *
 * Closing a conversation never removes an ordinary worktree. An ephemeral one
 * is tied to the conversation that created it (`ownerTabId` in the registry),
 * and when that conversation closes the worktree goes through Retire's own
 * steps:
 *
 * 1. Retire's pre-flight (`resolveRetireBlockers`) over the worktree and every
 *    bench its removal would prune. Active work anywhere there keeps it.
 * 2. Retire's removal: the landed cleanup for a landed worktree, otherwise
 *    Retire's discard, whose appraisal decides inside the repository's mutation
 *    slot. Unless the project allows discarding (`ephemeralMayDiscard`), the
 *    discard refuses on any unlanded work instead of preserving and removing.
 * 3. Retire's relocation (`closeOccupants`), so no tab is left on a deleted
 *    directory.
 *
 * Anything that keeps the worktree turns it into an ordinary worktree for good
 * and records the reason, which the worktree list shows the operator. Another
 * conversation still open there is such a reason: its owner is gone, so it
 * stays as an ordinary worktree rather than vanishing under that conversation.
 */
import type { TabState } from '@ion/shared/types'
import { collectOccupantsAcross } from '@ion/shared/worktree-occupants'
import type { StoreGet, StoreSet } from '../session-store-types'
import { rDebug, rInfo, rWarn } from '../rendererLogger'
import { closeOccupants, resolveRetireBlockers } from './worktree-occupant-close'
import {
  gitWorktreeDiscard,
  gitWorktreeEphemeralPolicy,
  gitWorktreeKeepEphemeral,
  gitWorktreeLandAndRetire,
  gitWorktreeRegistration,
  gitWorktreeRetirePreview,
} from '../host-api'

const TAG = 'worktree.ephemeral'

/** Worktree paths with a release in flight; a second close of the same owner is a no-op. */
const releasing = new Set<string>()

export async function releaseEphemeralWorktreeOnClose(
  set: StoreSet,
  get: StoreGet,
  closed: TabState,
): Promise<void> {
  const worktree = closed.worktree
  if (!worktree) return
  const worktreePath = worktree.worktreePath
  try {
    const { registration } = await gitWorktreeRegistration(worktreePath)
    if (!registration?.ephemeral) {
      rDebug(TAG, 'closed conversation left an ordinary worktree in place', {
        tab_id: closed.id.slice(0, 8), worktree_path: worktreePath,
      })
      return
    }
    if (registration.ephemeral.ownerTabId !== closed.id) {
      rDebug(TAG, 'closed conversation does not own the ephemeral worktree', {
        tab_id: closed.id.slice(0, 8), worktree_path: worktreePath,
        owner_tab_id: registration.ephemeral.ownerTabId ?? '',
      })
      return
    }
    // Read after the registry await: every close route has removed the tab
    // from the active workspace by then, and one that is still here was refused.
    if (get().tabs.some((tab) => tab.id === closed.id)) {
      rInfo(TAG, 'conversation is still open; ephemeral worktree untouched', {
        tab_id: closed.id.slice(0, 8), worktree_path: worktreePath,
      })
      return
    }
    if (releasing.has(worktreePath)) {
      rDebug(TAG, 'ephemeral release already in flight', { worktree_path: worktreePath })
      return
    }
    releasing.add(worktreePath)
    try {
      await release(set, get, closed, {
        repoPath: registration.repoPath || worktree.repoPath,
        worktreePath,
        branchName: registration.branchName || worktree.branchName,
        sourceBranch: registration.sourceBranch ?? worktree.sourceBranch,
        landed: registration.landedAt != null,
      })
    } finally {
      releasing.delete(worktreePath)
    }
  } catch (err) {
    rWarn(TAG, 'ephemeral release failed; worktree left as it was', {
      tab_id: closed.id.slice(0, 8), worktree_path: worktreePath, error: String(err),
    })
  }
}

/** The fields Retire's landed cleanup and discard both report. */
interface RemovalResult {
  ok: boolean
  error?: string
  refusedUnlanded?: boolean
  workingDirectory?: string
  prunedBenchPaths?: string[]
  recoveryRef?: string
}

interface ReleaseTarget {
  repoPath: string
  worktreePath: string
  branchName: string
  sourceBranch: string
  landed: boolean
}

async function release(set: StoreSet, get: StoreGet, closed: TabState, target: ReleaseTarget): Promise<void> {
  const { repoPath, worktreePath } = target
  rInfo(TAG, 'owner closed; appraising ephemeral worktree', {
    tab_id: closed.id.slice(0, 8), worktree_path: worktreePath, landed: target.landed,
  })

  const others = collectOccupantsAcross(get().tabs, [worktreePath]).filter((tab) => !tab.isTerminalOnly)
  if (others.length > 0) {
    await keep(get, target, `${others.length} other conversation${others.length === 1 ? ' is' : 's are'} still open in it.`)
    return
  }

  const { prunedBenchPaths } = await gitWorktreeRetirePreview(worktreePath)
  const blockers = resolveRetireBlockers(get, worktreePath, prunedBenchPaths ?? [])
  if (blockers) {
    await keep(get, target, blockers.error)
    return
  }

  let result: RemovalResult
  if (target.landed) {
    result = await gitWorktreeLandAndRetire({
      repoPath, worktreePath, worktreeBranch: target.branchName,
      branchName: target.branchName, sourceBranch: target.sourceBranch,
    })
  } else {
    const policy = await gitWorktreeEphemeralPolicy(repoPath)
    rDebug(TAG, 'ephemeral discard policy', {
      worktree_path: worktreePath, may_discard: policy.ephemeralMayDiscard,
    })
    result = await gitWorktreeDiscard({
      repoPath, worktreePath, branchName: target.branchName,
      sourceBranch: target.sourceBranch, onlyIfSafe: !policy.ephemeralMayDiscard,
    })
  }

  if (!result.ok) {
    await keep(get, target, result.refusedUnlanded
      ? `${result.error ?? 'It holds work that has not landed.'} It was kept so nothing is lost.`
      : `Removing it failed: ${result.error ?? 'unknown error'}`)
    return
  }

  rInfo(TAG, 'ephemeral worktree removed with its conversation', {
    tab_id: closed.id.slice(0, 8), worktree_path: worktreePath,
    recovery_ref: result.recoveryRef ?? '', pruned_benches: result.prunedBenchPaths?.length ?? 0,
  })
  await closeOccupants(set, get, [worktreePath, ...(result.prunedBenchPaths ?? [])], result.workingDirectory)
  await get().refreshWorktreeInventory(repoPath)
}

async function keep(get: StoreGet, target: ReleaseTarget, reason: string): Promise<void> {
  const { ok } = await gitWorktreeKeepEphemeral(target.worktreePath, reason)
  if (ok) {
    rInfo(TAG, 'ephemeral worktree kept and made ordinary', { worktree_path: target.worktreePath, reason })
  } else {
    rWarn(TAG, 'ephemeral worktree kept but the registry did not record why', {
      worktree_path: target.worktreePath, reason,
    })
  }
  await get().refreshWorktreeInventory(target.repoPath)
}

/** Test seam: forget in-flight releases between cases. */
export function resetEphemeralReleaseForTests(): void {
  releasing.clear()
}
