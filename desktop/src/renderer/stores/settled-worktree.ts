import type { TabState } from '../../shared/types'
import { rWarn } from '../rendererLogger'
import { settlingIsPermanent } from '../../shared/worktree-conversations'

/**
 * A settled worktree conversation can become active only while its checkout
 * still exists. The directory is the execution boundary; resuming against the
 * source repo would silently move old work into a different checkout.
 */
export async function settledRecordCanRestore(tab: TabState): Promise<boolean> {
  // An ephemeral role settles permanently: a bench conversation's checkout is
  // rebuilt underneath it, and a machine conversation cannot be typed in at
  // all. Checked before the worktree probe because the answer does not depend
  // on the filesystem and must not change when a bench is torn down.
  if (settlingIsPermanent(tab.tabRole)) {
    rWarn('inbox', 'settled conversation restore refused because its role settles permanently', {
      tab_id: tab.id.slice(0, 8),
      tab_role: tab.tabRole ?? 'none',
    })
    return false
  }
  if (!tab.worktree) return true
  try {
    const { exists } = await window.ion.fsExists(tab.worktree.worktreePath)
    if (exists) return true
    rWarn('inbox', 'settled conversation restore refused because worktree was retired', {
      tab_id: tab.id.slice(0, 8),
      worktree_path: tab.worktree.worktreePath,
    })
    return false
  } catch (error) {
    rWarn('inbox', 'settled conversation restore refused because worktree state is unknown', {
      tab_id: tab.id.slice(0, 8),
      worktree_path: tab.worktree.worktreePath,
      error: String(error),
    })
    return false
  }
}

/**
 * Synchronous UI projection of the same rule. An absent repo cache means the
 * answer is not ready, so the action remains visible and the definitive
 * filesystem check still guards execution.
 */
export function settledRecordRestorableFromInventory(
  tab: TabState,
  inventory: ReadonlyMap<string, readonly { worktreePath: string }[]>,
): boolean {
  // Same terminal-role rule as the async gate. This one is definitive rather
  // than provisional: the role is stored on the record, so no cache has to be
  // warm for the answer to be correct.
  if (settlingIsPermanent(tab.tabRole)) return false
  if (!tab.worktree) return true
  const entries = inventory.get(tab.worktree.repoPath)
  return entries == null || entries.some((entry) => entry.worktreePath === tab.worktree!.worktreePath)
}
