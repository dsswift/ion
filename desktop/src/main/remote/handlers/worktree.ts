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
import { getWorktreeInventory } from '../../worktree/inventory-service'
import { syncWorktreeFromSource, landWorktree } from '../../worktree/integrate'
import {
  listWorkspaces, assembleWorkspace, updateMember, updateAllStale,
  setMemberEnabled, setMemberReview, setMemberOrder, addMember, removeMember,
  refreshStaleness, sourceBranchTip,
} from '../../integration/bench-ops'
import {
  collectDirConversations,
  pickDirTerminal,
  benchTerminalTitle,
  type DirConversation,
  type DirConversationSource,
} from '../../../shared/worktree-conversations'
import type { RemoteCommand, RemoteWorktreeState, RemoteWorktree, RemoteBench, RemoteMembership } from '../protocol'
import type { IntegrationWorkspace } from '../../../shared/types'

const TAG = 'remote.worktree'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * The tabs the desktop currently holds, plus the per-directory conversation
 * collector built over them.
 *
 * iOS needs two different answers from one snapshot: which conversations are
 * open in each directory (so it can focus one instead of duplicating, and can
 * say WHICH conversations a worktree holds), and which terminal belongs to a
 * bench. Both derive from the same tab list, so it is read once and returned
 * alongside the collector rather than fetched twice.
 *
 * Built with the same `collectDirConversations` / `pickDirTerminal` the desktop
 * rows use, so the three surfaces cannot disagree about what is open where.
 */
async function readTabsForProjection(): Promise<{
  tabs: DirConversationSource[]
  openIn: (dir: string) => DirConversation[]
}> {
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
      // Carried so a terminal is never counted as a conversation, and so the
      // bench terminal can be resolved at all.
      isTerminalOnly: t.isTerminalOnly ?? false,
    }))
  } catch (err) {
    // Losing this costs the "already open" hint, the conversation names, and the
    // bench terminal id — never correctness of the worktree state itself.
    warn('could not resolve open conversations', { error: String(err) })
  }
  return { tabs, openIn: (dir: string) => collectDirConversations(tabs, dir) }
}

/** One membership, wire-shaped. Order is the caller's array position. */
function projectMembership(
  m: IntegrationWorkspace['members'][number],
  sourceBranch: string,
  order: number,
): RemoteMembership {
  return {
    sourceBranch,
    enabled: m.enabled,
    pin: m.pin,
    merge: m.merge,
    review: m.review,
    pinnedSha: m.pinnedSha,
    order,
    conflictPaths: m.conflictPaths,
    conflictsWith: m.conflictsWith,
    mergeResolution: m.mergeResolution,
  }
}

/**
 * Build the per-repo worktree + bench projection for iOS.
 *
 * One worktree yields ONE wire record, with its bench membership attached when
 * it has one. The bench used to re-send every member as a separate
 * `RemoteBenchMember` carrying its own copy of the worktree's path, branch, and
 * label -- so an enrolled worktree crossed the wire twice and iOS rendered it in
 * two sections with two vocabularies.
 */
export async function buildWorktreeState(repoPath: string): Promise<RemoteWorktreeState> {
  const { tabs, openIn } = await readTabsForProjection()
  // Through the service so an iOS refresh rides the same cached crawl the
  // desktop panels just ran instead of starting a competing one.
  const inventory = await getWorktreeInventory(repoPath)

  // Staleness is refreshed BEFORE the join so the memberships attached below are
  // the current ones, not the values from the last build.
  const workspaces: IntegrationWorkspace[] = []
  for (const ws of listWorkspaces(repoPath)) {
    workspaces.push((await refreshStaleness(repoPath, ws.sourceBranch)) ?? ws)
  }

  // Membership by worktree path, with its merge position. Array order IS merge
  // order, so the index is read here rather than stored on the record.
  const membershipOf = new Map<string, RemoteMembership>()
  for (const ws of workspaces) {
    ws.members.forEach((m, i) => {
      membershipOf.set(m.worktreePath, projectMembership(m, ws.sourceBranch, i + 1))
    })
  }

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
    landedAt: w.landedAt,
    provisionState: w.provisionState,
    provisionError: w.provisionError,
    operationState: w.operationState,
    conflictedCount: w.conflictedPaths?.length,
    openConversations: openIn(w.worktreePath),
    membership: membershipOf.get(w.worktreePath),
  }))

  const present = new Set(inventory.map((w) => w.worktreePath))
  const benches: RemoteBench[] = []
  for (const ws of workspaces) {
    const tip = await sourceBranchTip(repoPath, ws.sourceBranch)
    // Derived from the tab's own state, never stored: absent means no terminal
    // is open for this bench, which is what lets iOS say "Open" vs "Go to".
    const terminal = pickDirTerminal(tabs, ws.benchPath, benchTerminalTitle(ws.sourceBranch))
    benches.push({
      repoPath: ws.repoPath,
      sourceBranch: ws.sourceBranch,
      benchPath: ws.benchPath,
      benchBranch: ws.benchBranch,
      baseSha: ws.baseSha,
      lastBuiltAt: ws.lastBuiltAt,
      lastAssembly: ws.lastAssembly,
      lastAssemblyError: ws.lastAssemblyError,
      baseDrifted: !!tip && !!ws.baseSha && tip !== ws.baseSha,
      openConversations: openIn(ws.benchPath),
      benchTerminalTabId: terminal?.id,
      // Only the memberships with no worktree left. The rest ride their
      // worktree record; sending them here too would restore the duplication
      // this projection exists to remove.
      orphans: ws.members
        .filter((m) => !present.has(m.worktreePath))
        .map((m, i) => projectMembership(m, ws.sourceBranch, i + 1)),
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
  operation: 'sync' | 'land' | 'assemble' | 'update' | 'update_all',
  result: { ok: boolean; error?: string; refusedDirty?: boolean; hasConflicts?: boolean; warning?: string },
): void {
  state.remoteTransport?.send({
    type: 'desktop_worktree_op_result',
    operation,
    ok: result.ok,
    error: result.error,
    refusedDirty: result.refusedDirty,
    hasConflicts: result.hasConflicts,
    warning: result.warning,
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
      log('open worktree conversation', {
        worktree_path: cmd.worktreePath,
        new_conversation: !!cmd.newConversation,
      })
      broadcast('ion:remote-open-worktree-conversation', {
        worktreePath: cmd.worktreePath,
        newConversation: !!cmd.newConversation,
      })
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

    case 'desktop_bench_open_terminal': {
      // Same routing as the conversation case: the renderer store owns tab
      // creation and naming, and broadcast() (not webContents.send) so the ATV
      // mirror sees the same event rather than diverging from the overlay.
      log('open bench terminal', { source_branch: cmd.sourceBranch })
      broadcast('ion:remote-open-bench-terminal', {
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

    case 'desktop_bench_assemble': {
      const result = await assembleWorkspace(cmd.repoPath, cmd.sourceBranch)
      sendResult('assemble', result)
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

    case 'desktop_bench_set_review':
      setMemberReview(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath, cmd.review)
      await pushWorktreeState(cmd.repoPath)
      return true

    case 'desktop_bench_reorder_member':
      setMemberOrder(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath, cmd.toIndex)
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
