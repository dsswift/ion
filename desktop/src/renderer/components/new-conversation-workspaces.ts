import type { WorktreeInfo, WorktreeInventoryEntry } from '../../shared/types'

/** Existing worktrees that can still accept new work. Landed checkouts are sealed. */
export function filterConversationWorktrees(entries: readonly WorktreeInventoryEntry[], query: string): WorktreeInventoryEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  return entries.filter((entry) => entry.landedAt == null && (!needle ||
    (entry.title ?? entry.label).toLocaleLowerCase().includes(needle) ||
    entry.label.toLocaleLowerCase().includes(needle) ||
    entry.branchName.toLocaleLowerCase().includes(needle) ||
    entry.worktreePath.toLocaleLowerCase().includes(needle)))
}

export function inventoryEntryToWorktree(repoPath: string, entry: WorktreeInventoryEntry): WorktreeInfo {
  return { repoPath, worktreePath: entry.worktreePath, branchName: entry.branchName, sourceBranch: entry.sourceBranch ?? '', landedAt: entry.landedAt }
}

export function filterBranches(branches: readonly string[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase()
  return branches.filter((branch) => !needle || branch.toLocaleLowerCase().includes(needle))
}
