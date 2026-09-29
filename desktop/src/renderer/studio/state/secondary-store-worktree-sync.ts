/**
 * secondary-store-worktree-sync — the mirror's worktree read model
 * (inventory, benches, conflict alerts, pipeline, operation ledger), the
 * UNION of every connected Environment's snapshot (ADR-033). Split from
 * secondary-store.ts at the file-size cap; same discipline as the tab and
 * terminal syncs there: revision-guarded per Environment. The Electron IPC
 * push describes the LOCAL Environment; a remote Environment's snapshot
 * arrives as a wire frame through `secondary-store-wire-sync.ts`.
 *
 * Every map here is keyed by repository path, and two Environments can each
 * have a repository at the same path (`/Users/josh/src/ion` on both Macs).
 * The merge is local-first: a remote entry never shadows a local one at the
 * same key, because the local Git panel and worktree rows must always
 * describe THIS machine. A remote tab's own worktree still renders from
 * `tab.worktree`, which rides the tab, not this read model.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { StudioWorktreeSnapshot, StudioGitConflictAlert, StudioWorktreePipeline, StudioWorkspaceOperation } from '@ion/shared/types-studio'
import type { WorktreeInventoryEntry, IntegrationWorkspace, IntegrationMember } from '@ion/shared/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { rDebug, rWarn } from '../../rendererLogger'

/** Last applied snapshot per Environment; the store fields below are recomputed from all of them on every change. */
const snapshotsByEnvironment = new Map<string, StudioWorktreeSnapshot>()

function mergeRecords<T>(target: Map<string, T>, source: Record<string, T>, environmentId: string, what: string): void {
  for (const [key, value] of Object.entries(source)) {
    if (target.has(key)) {
      rDebug('studio.mirror', 'worktree read model: remote entry shadowed by an earlier one at the same path', { environment_id: environmentId, what, key })
      continue
    }
    target.set(key, value)
  }
}

function mergePairs<T>(target: Map<string, T>, source: Array<[string, T]>): void {
  for (const [key, value] of source) if (!target.has(key)) target.set(key, value)
}

/** The per-Environment snapshots in merge order: local first, so a local entry always wins a shared key. */
function orderedSnapshots(): Array<[string, StudioWorktreeSnapshot]> {
  return [...snapshotsByEnvironment.entries()].sort(([a], [b]) => (a === LOCAL_ENVIRONMENT_ID ? -1 : b === LOCAL_ENVIRONMENT_ID ? 1 : 0))
}

/**
 * The Environment whose snapshot supplies `repoPath`'s rows in the merged
 * read model, from its worktree inventory or else its benches. The merged
 * maps drop which machine an entry came from, and a verb started from a
 * worktree row (a new conversation in that worktree, a refresh) has to run
 * on the machine that has the worktree. Same order as the merge, so this
 * names exactly the entry the row rendered. Null when no snapshot has the
 * repository.
 */
export function environmentOfWorktreeRepo(repoPath: string): string | null {
  const has = (record: Record<string, unknown>): boolean => Object.prototype.hasOwnProperty.call(record, repoPath)
  const ordered = orderedSnapshots()
  for (const [environmentId, snapshot] of ordered) if (has(snapshot.inventory)) return environmentId
  for (const [environmentId, snapshot] of ordered) if (has(snapshot.workspaces)) return environmentId
  return null
}

/**
 * The Environment whose worktree read model holds `path` as a repository, a
 * worktree, or a bench: the machine a verb on that path has to run on. Same
 * order as the merge. Null when no snapshot knows the path.
 */
export function environmentOfWorkspacePath(path: string): string | null {
  const repoEnvironment = environmentOfWorktreeRepo(path)
  if (repoEnvironment) return repoEnvironment
  for (const [environmentId, snapshot] of orderedSnapshots()) {
    for (const entries of Object.values(snapshot.inventory)) {
      if (entries.some((entry) => entry.worktreePath === path)) return environmentId
    }
    for (const workspaces of Object.values(snapshot.workspaces)) {
      if (workspaces.some((workspace) => workspace.benchPath === path)) return environmentId
    }
  }
  return null
}

/** Recompute every worktree store field from the per-Environment snapshots, local first. */
function publishMerged(): void {
  const ordered = orderedSnapshots()
  const worktreeInventory = new Map<string, WorktreeInventoryEntry[]>()
  const benchWorkspaces = new Map<string, IntegrationWorkspace[]>()
  const benchSourceTips = new Map<string, Record<string, string>>()
  const benchRetired = new Map<string, Map<string, IntegrationMember[]>>()
  const gitConflictAlerts = new Map<string, StudioGitConflictAlert>()
  const workspaceOperationLedger = new Map<string, StudioWorkspaceOperation>()
  let worktreePipeline: StudioWorktreePipeline | null = null
  for (const [environmentId, snapshot] of ordered) {
    mergeRecords(worktreeInventory, snapshot.inventory, environmentId, 'inventory')
    mergeRecords(benchWorkspaces, snapshot.workspaces, environmentId, 'workspaces')
    mergePairs(benchSourceTips, snapshot.benchSourceTips)
    for (const [repoPath, entries] of snapshot.benchRetired) if (!benchRetired.has(repoPath)) benchRetired.set(repoPath, new Map(entries))
    mergePairs(gitConflictAlerts, snapshot.gitConflictAlerts)
    for (const operation of snapshot.workspaceOperationLedger) if (!workspaceOperationLedger.has(operation.id)) workspaceOperationLedger.set(operation.id, operation)
    if (worktreePipeline === null) worktreePipeline = snapshot.worktreePipeline
  }
  useSessionStore.setState({
    worktreeInventory,
    benchWorkspaces,
    benchSourceTips,
    benchRetired,
    gitConflictAlerts,
    worktreePipeline: worktreePipeline as never,
    workspaceOperationLedger,
  })
}

/**
 * Forget ONE Environment's slice entirely, so nothing it published is left
 * in the merged read model. Used when an Environment goes offline: a
 * worktree row names a checkout on a machine this desktop can no longer
 * reach, and acting on it (landing, syncing, starting a conversation there)
 * would be a decision made against state that may already have moved.
 */
export function dropWorktreeEnvironment(environmentId: string): boolean {
  if (!snapshotsByEnvironment.delete(environmentId)) return false
  publishMerged()
  rDebug('studio.mirror', 'worktree snapshot dropped with its environment', { environment_id: environmentId, environments: snapshotsByEnvironment.size })
  return true
}

/** Replace ONE Environment's slice of the worktree read model from that server's complete snapshot. Returns that snapshot's `ready`. */
export function hydrateWorktreeFromSync(snapshot: StudioWorktreeSnapshot, environmentId: string = LOCAL_ENVIRONMENT_ID): boolean {
  if (!snapshot || typeof snapshot !== 'object' || !Number.isSafeInteger(snapshot.revision)) {
    rWarn('studio.mirror', 'worktree snapshot malformed, ignored', { environment_id: environmentId })
    return false
  }
  const previous = snapshotsByEnvironment.get(environmentId)
  if (previous && snapshot.revision <= previous.revision) return false
  snapshotsByEnvironment.set(environmentId, snapshot)
  publishMerged()
  rDebug('studio.mirror', 'worktree snapshot hydrated', {
    environment_id: environmentId,
    revision: snapshot.revision,
    ready: String(snapshot.ready),
    repositories: Object.keys(snapshot.inventory).length,
    environments: snapshotsByEnvironment.size,
  })
  return snapshot.ready
}
