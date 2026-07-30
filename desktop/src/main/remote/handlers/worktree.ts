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
import {
  collectDirConversations,
  type DirConversation,
  type DirConversationSource,
} from '../../../shared/worktree-conversations'
import type { RemoteCommand, RemoteWorktreeState, RemoteWorktree, RemoteBench } from '../protocol'

const TAG = 'remote.worktree'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * The conversations open in each directory, so iOS can focus one instead of
 * duplicating — and can say WHICH conversations a worktree holds.
 *
 * Built with the same `collectDirConversations` the desktop rows use, so the
 * three surfaces cannot disagree about what is open where.
 */
async function conversationsByDirectory(): Promise<(dir: string) => DirConversation[]> {
  let tabs: DirConversationSource[] = []
  try {
    const { getRemoteTabStates } = await import('../snapshot')
    const snapshot = await getRemoteTabStates()
    tabs = snapshot.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      customTitle: t.customTitle ?? null,
      status: t.status,
      workingDirectory: t.workingDirectory ?? '',
    }))
  } catch (err) {
    // Losing this costs the "already open" hint and the conversation names,
    // never correctness of the worktree state itself.
    warn('could not resolve open conversations', { error: String(err) })
  }
  return (dir: string) => collectDirConversations(tabs, dir)
}

/** Build the per-repo worktree + bench projection for iOS. */
export async function buildWorktreeState(repoPath: string): Promise<RemoteWorktreeState> {
  const openIn = await conversationsByDirectory()
  const inventory = await inventoryWorktrees(repoPath)
  // Projected field by field rather than spread: `conflictedPaths` is a
  // desktop-only field (only the desktop can resolve conflicts, so only it has
  // a surface for the paths), and a spread would ship the array to a client
  // that reads nothing but the count. iOS gets `conflictedCount` — the number
  // its row badge actually renders.
  const worktrees: RemoteWorktree[] = inventory.map((w) => ({
    worktreePath: w.worktreePath,
    branchName: w.branchName,
    label: w.label,
    title: w.title,
    sourceBranch: w.sourceBranch,
    head: w.head,
    lastCommitSubject: w.lastCommitSubject,
    isDirty: w.isDirty,
    unlandedCommitCount: w.unlandedCommitCount,
    needsSync: w.needsSync,
    safeToDiscard: w.safeToDiscard,
    provisionState: w.provisionState,
    provisionError: w.provisionError,
    operationState: w.operationState,
    conflictedCount: w.conflictedPaths?.length,
    openConversations: openIn(w.worktreePath),
  }))

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
      openConversations: openIn(refreshed.benchPath),
      members: refreshed.members.map((m) => ({
        worktreePath: m.worktreePath,
        branchName: m.branchName,
        label: m.label,
        // Resolved from the worktree inventory rather than stored on the member
        // record: one worktree has one title, and a second copy would drift the
        // moment the worktree is renamed.
        title: inventory.find((w) => w.worktreePath === m.worktreePath)?.title,
        enabled: m.enabled,
        pinnedSha: m.pinnedSha,
        status: m.status,
        conflictPaths: m.conflictPaths,
        conflictsWith: m.conflictsWith,
        openConversations: openIn(m.worktreePath),
      })),
    })
  }

  return { repoPath, worktrees, benches }
}

/**
 * Push the current worktree + bench state for a repo to iOS.
 *
 * Exported because the titling path renames a worktree outside any iOS command
 * and must push the new name; without that the phone shows the slug until its
 * next manual refresh.
 */
export async function pushWorktreeState(repoPath: string): Promise<void> {
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
      await pushWorktreeState(cmd.repoPath)
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
      await pushWorktreeState(cmd.repoPath)
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
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_rebuild': {
      const result = await rebuildWorkspace(cmd.repoPath, cmd.sourceBranch)
      sendResult('rebuild', result)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_update_member': {
      const result = await updateMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath)
      sendResult('update', result)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_update_all': {
      const result = await updateAllStale(cmd.repoPath, cmd.sourceBranch)
      sendResult('update_all', result)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_set_enabled':
      setMemberEnabled(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath, cmd.enabled)
      await pushWorktreeState(cmd.repoPath)
      return true

    case 'desktop_bench_add_member': {
      const result = await addMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath, cmd.branchName)
      if (!result.ok) warn('add member refused', { branch: cmd.branchName, error: result.error ?? '' })
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_remove_member':
      removeMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath)
      await pushWorktreeState(cmd.repoPath)
      return true

    default:
      return false
  }
}
