/**
 * Worktree inventory + lifecycle store slice — the shared model behind every
 * worktree surface.
 *
 * One slice feeds all of them (git-panel Worktrees section, the new-tab picker
 * group, the ATV mount, and the iOS projection), so there is no second
 * implementation to drift. Per AGENTS.md § ATV shell rules, the multi-step
 * flows live here as single store actions rather than in component handlers:
 * a handler runs in whichever window hosts it, and in the ATV mirror that mixes
 * forwarded and local calls while reading stale mirror state.
 */
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { rInfo, rWarn, rDebug } from '../../rendererLogger'
import { setTabWorkingDirectory } from './tab-working-directory'

export function createWorktreeInventorySlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    /**
     * Refresh the worktree list for a repo.
     *
     * Keyed by repo path so several projects can be open at once without their
     * inventories overwriting each other.
     */
    refreshWorktreeInventory: async (repoPath) => {
      if (!repoPath || repoPath === '~') return
      try {
        const { worktrees } = await window.ion.gitWorktreeInventory(repoPath)
        set((s) => ({
          worktreeInventory: new Map(s.worktreeInventory).set(repoPath, worktrees),
        }))
        rDebug('worktree.inventory', 'refreshed', { repo_path: repoPath, count: worktrees.length })
      } catch (err) {
        rWarn('worktree.inventory', 'refresh failed', { repo_path: repoPath, error: String(err) })
      }
    },

    /**
     * Open a conversation in a worktree — the re-entry path after a tab close.
     *
     * If a tab is ALREADY open on that worktree, focus it instead of creating a
     * second conversation in the same directory. Without this the operator
     * accumulates duplicate conversations in one worktree, which is the problem
     * the inventory exists to solve, not a new one to create.
     */
    openWorktreeConversation: async (worktreePath) => {
      const existing = get().tabs.find((t) => t.workingDirectory === worktreePath)
      if (existing) {
        rInfo('worktree.inventory', 'focusing existing conversation for worktree', {
          worktree_path: worktreePath,
          tab_id: existing.id.slice(0, 8),
        })
        get().selectTab(existing.id)
        return existing.id
      }

      rInfo('worktree.inventory', 'opening new conversation in worktree', { worktree_path: worktreePath })
      // createTabInDirectory with useWorktree=false: the worktree already
      // exists, so this must NOT create another one inside it.
      const tabId = await get().createTabInDirectory(worktreePath, false, true)

      // Attach the worktree metadata so the tab gets the worktree affordances
      // (land, sync, retire) rather than reading as a plain directory tab.
      const repoPath = [...get().worktreeInventory.keys()].find((repo) =>
        (get().worktreeInventory.get(repo) ?? []).some((w) => w.worktreePath === worktreePath))
      const entry = repoPath
        ? (get().worktreeInventory.get(repoPath) ?? []).find((w) => w.worktreePath === worktreePath)
        : undefined
      if (repoPath && entry?.sourceBranch) {
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === tabId
            ? {
                ...t,
                worktree: {
                  worktreePath,
                  branchName: entry.branchName,
                  sourceBranch: entry.sourceBranch!,
                  repoPath,
                },
              }
            : t),
        }))
      } else {
        // Without a known source branch the lifecycle verbs are unanswerable.
        // Leave `worktree` unset rather than inventing a source branch: the tab
        // still works as a directory conversation, and the UI asks.
        rWarn('worktree.inventory', 'opened worktree conversation without known source branch', {
          worktree_path: worktreePath,
        })
      }
      return tabId
    },

    /**
     * Retire a worktree, first relocating any conversation living inside it.
     *
     * ── Why this is a store action, not a component handler ─────────────────
     * It reads store state between mutations (find the tab on this worktree,
     * relocate it, then remove the directory). Per AGENTS.md § ATV shell rules a
     * component handler doing that would mix forwarded and local calls in the
     * mirror and decide against stale mirror state.
     *
     * ── Why the relocation comes first ──────────────────────────────────────
     * `retireWorktree` deletes the directory. A conversation still pointed at it
     * would be left with a working directory that does not exist — the engine
     * would fail to start the session on the next prompt, and a later resume
     * from the session browser would open into nothing. `retireWorktree` already
     * returns the directory the conversation should move to (the repo root), and
     * that return value was previously discarded.
     *
     * The relocation is best-effort: if it fails the retire is still attempted,
     * because leaving the worktree behind AND the conversation pointed at it is
     * strictly worse than a conversation whose next prompt gets reconciled by
     * the main process. Both outcomes log.
     */
    retireWorktree: async (repoPath, worktreePath, branchName) => {
      const occupant = get().tabs.find((t) => t.workingDirectory === worktreePath)
      rInfo('worktree.inventory', 'retire requested', {
        worktree_path: worktreePath,
        branch: branchName,
        occupant_tab: occupant ? occupant.id.slice(0, 8) : 'none',
      })

      const result = await window.ion.gitWorktreeRetire({
        repoPath,
        worktreePath,
        branchName,
        // Force only after the caller confirmed against a concrete appraisal.
        force: true,
      })

      if (!result.ok) {
        rWarn('worktree.inventory', 'retire refused; nothing relocated', {
          worktree_path: worktreePath, error: result.error ?? '',
        })
        await get().refreshWorktreeInventory(repoPath)
        return result
      }

      // The worktree is gone. Move its conversation to the directory the retire
      // nominated (the repo root) so the tab is not pointed at a dead path.
      const relocateTo = result.workingDirectory
      if (occupant && relocateTo) {
        await setTabWorkingDirectory(set, get, occupant.id, relocateTo, {
          worktree: null,
          pendingWorktreeSetup: false,
        })
      } else if (occupant) {
        rWarn('worktree.inventory', 'retire returned no relocation target; tab left on a dead path', {
          worktree_path: worktreePath, tab_id: occupant.id.slice(0, 8),
        })
      }

      await get().refreshWorktreeInventory(repoPath)
      return result
    },

    /**
     * Sync a worktree onto its source branch (resolves BASE staleness), then
     * refresh the inventory so the badge clears.
     */
    syncWorktree: async (worktreePath, sourceBranch, repoPath) => {
      rInfo('worktree.inventory', 'sync requested', { worktree_path: worktreePath, source_branch: sourceBranch })
      const result = await window.ion.gitWorktreeSync(worktreePath, sourceBranch)
      if (!result.ok) {
        rWarn('worktree.inventory', 'sync failed', {
          worktree_path: worktreePath,
          refused_dirty: !!result.refusedDirty,
          has_conflicts: !!result.hasConflicts,
          error: result.error ?? '',
        })
      }
      await get().refreshWorktreeInventory(repoPath)
      return result
    },
  }
}
