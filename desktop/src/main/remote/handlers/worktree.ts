/**
 * Remote worktree + bench handlers (iOS → desktop).
 *
 * iOS cannot see the git panel and the desktop's renderer store, so these
 * handlers read the same main-process sources the desktop UI reads and push a
 * projected state back. One owner, three renderers: the desktop overlay, the
 * ATV mirror, and iOS all render main-process truth, so the pin/staleness
 * vocabulary cannot drift between them.
 *
 * Verb results come back as a typed `desktop_worktree_op_result` rather than
 * being inferred from a state diff, so iOS can distinguish "refused, you can
 * fix this" from "failed" and say which.
 */
import { state } from '../../state'
import { broadcast } from '../../broadcast'
import { log as _log, warn as _warn } from '../../logger'
import { inventoryWorktrees } from '../../worktree/inventory'
import { syncWorktreeFromSource, landWorktree } from '../../worktree/integrate'
import {
  listWorkspaces, rebuildWorkspace, updateMember, updateAllStale,
  setMemberEnabled, addMember, removeMember, refreshStaleness, sourceBranchTip,
} from '../../integration/bench-ops'
import type { RemoteCommand, RemoteWorktreeState, RemoteBench } from '../protocol'

const TAG = 'remote.worktree'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Tab ids by working directory, so iOS can focus instead of duplicating. */
async function openTabsByDirectory(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const { getRemoteTabStates } = await import('../snapshot')
    const snapshot = await getRemoteTabStates()
    for (const t of snapshot.tabs) {
      if (t.workingDirectory) map.set(t.workingDirectory, t.id)
    }
  } catch (err) {
    // Losing this only costs the "already open" hint, never correctness.
    warn('could not resolve open tabs', { error: String(err) })
  }
  return map
}

/** Build the per-repo worktree + bench projection for iOS. */
export async function buildWorktreeState(repoPath: string): Promise<RemoteWorktreeState> {
  const openTabs = await openTabsByDirectory()
  const worktrees = (await inventoryWorktrees(repoPath)).map((w) => {
    // Project conflictedPaths down to a count: iOS renders "N conflicted", and
    // shipping the path list would put repository file names on the wire for a
    // surface that cannot act on them (resolution is desktop-only).
    const { conflictedPaths, ...rest } = w
    return {
      ...rest,
      conflictedCount: conflictedPaths?.length,
      openTabId: openTabs.get(w.worktreePath),
    }
  })

  const benches: RemoteBench[] = []
  for (const ws of listWorkspaces(repoPath)) {
    const refreshed = (await refreshStaleness(repoPath, ws.sourceBranch)) ?? ws
    const tip = await sourceBranchTip(repoPath, ws.sourceBranch)
    benches.push({
      repoPath: refreshed.repoPath,
      sourceBranch: refreshed.sourceBranch,
      benchPath: refreshed.benchPath,
      benchBranch: refreshed.benchBranch,
      baseSha: refreshed.baseSha,
      lastBuiltAt: refreshed.lastBuiltAt,
      baseDrifted: !!tip && !!refreshed.baseSha && tip !== refreshed.baseSha,
      openTabId: openTabs.get(refreshed.benchPath),
      members: refreshed.members.map((m) => ({
        worktreePath: m.worktreePath,
        branchName: m.branchName,
        label: m.label,
        enabled: m.enabled,
        pinnedSha: m.pinnedSha,
        status: m.status,
        conflictPaths: m.conflictPaths,
        conflictsWith: m.conflictsWith,
      })),
    })
  }

  return { repoPath, worktrees, benches }
}

async function pushState(repoPath: string): Promise<void> {
  const stateForRepo = await buildWorktreeState(repoPath)
  state.remoteTransport?.send({ type: 'desktop_worktree_state', states: [stateForRepo] })
  log('pushed worktree state', {
    repo_path: repoPath,
    worktrees: stateForRepo.worktrees.length,
    benches: stateForRepo.benches.length,
  })
}

function sendResult(
  operation: 'sync' | 'land' | 'rebuild' | 'update' | 'update_all',
  result: { ok: boolean; error?: string; refusedDirty?: boolean; hasConflicts?: boolean },
): void {
  state.remoteTransport?.send({
    type: 'desktop_worktree_op_result',
    operation,
    ok: result.ok,
    error: result.error,
    refusedDirty: result.refusedDirty,
    hasConflicts: result.hasConflicts,
  })
}

export async function handleWorktreeCommand(cmd: RemoteCommand): Promise<boolean> {
  switch (cmd.type) {
    case 'desktop_worktree_refresh':
      await pushState(cmd.repoPath)
      return true

    case 'desktop_worktree_open_conversation': {
      // Tab creation lives in the renderer store (it owns panes and titling),
      // so route through the owner window rather than duplicating that logic.
      // broadcast(), not webContents.send: the ATV mirror must see the same
      // event or its tab list silently diverges from the overlay's.
      log('open worktree conversation', { worktree_path: cmd.worktreePath })
      broadcast('ion:remote-open-worktree-conversation', cmd.worktreePath)
      return true
    }

    case 'desktop_bench_open_conversation': {
      log('open bench conversation', { source_branch: cmd.sourceBranch })
      broadcast('ion:remote-open-bench-conversation', {
        repoPath: cmd.repoPath,
        sourceBranch: cmd.sourceBranch,
      })
      return true
    }

    case 'desktop_worktree_sync': {
      const result = await syncWorktreeFromSource(cmd.worktreePath, cmd.sourceBranch)
      sendResult('sync', result)
      await pushState(cmd.repoPath)
      return true
    }

    case 'desktop_worktree_land': {
      const result = await landWorktree({
        repoPath: cmd.repoPath,
        worktreePath: cmd.worktreePath,
        worktreeBranch: cmd.worktreeBranch,
        sourceBranch: cmd.sourceBranch,
      })
      sendResult('land', result)
      await pushState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_rebuild': {
      const result = await rebuildWorkspace(cmd.repoPath, cmd.sourceBranch)
      sendResult('rebuild', result)
      await pushState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_update_member': {
      const result = await updateMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath)
      sendResult('update', result)
      await pushState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_update_all': {
      const result = await updateAllStale(cmd.repoPath, cmd.sourceBranch)
      sendResult('update_all', result)
      await pushState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_set_enabled':
      setMemberEnabled(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath, cmd.enabled)
      await pushState(cmd.repoPath)
      return true

    case 'desktop_bench_add_member': {
      const result = await addMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath, cmd.branchName)
      if (!result.ok) warn('add member refused', { branch: cmd.branchName, error: result.error ?? '' })
      await pushState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_remove_member':
      removeMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath)
      await pushState(cmd.repoPath)
      return true

    default:
      return false
  }
}
