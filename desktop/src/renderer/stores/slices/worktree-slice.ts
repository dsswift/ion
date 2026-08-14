import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { landFlagsForStrategy } from '../../../shared/worktree-land-strategy'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'
import { seedWorktreeFromTab } from './event-slice-titling'
import { evaluateSessionBusyGuard, formatSessionBusyRefusal } from './session-busy-guard'
import { setTabWorkingDirectory } from './tab-working-directory'

export function createWorktreeSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    setupWorktree: async (tabId, sourceBranch, setAsDefault) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      const repoPath = tab.workingDirectory

      if (setAsDefault) {
        usePreferencesStore.getState().setWorktreeBranchDefault(repoPath, sourceBranch)
      }

      const result = await window.ion.gitWorktreeAdd(repoPath, sourceBranch)
      if (result.ok && result.worktree) {
        // Carry this conversation's name onto the worktree it was just cut for.
        seedWorktreeFromTab(tab, result.worktree.worktreePath)
        // Route through setTabWorkingDirectory: this tab's engine session is
        // already live in the base repo (it was started at tab creation), so
        // patching only renderer state would leave the agent working in the repo
        // while the UI shows the worktree. The helper relocates the live session
        // as well.
        await setTabWorkingDirectory(set, get, tabId, result.worktree.worktreePath, {
          worktree: result.worktree,
          pendingWorktreeSetup: false,
        })
      } else {
        rWarn('worktree', 'setup refused; tab left in the base repo', {
          tab_id: tabId.slice(0, 8), repo_path: repoPath, source_branch: sourceBranch,
          error: result.error ?? 'unknown',
        })
      }
    },

    convertToWorktree: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return

      // Action-layer guard, mirroring closeTab's. Conversion relocates the tab,
      // and relocation restarts the engine session (setTabWorkingDirectory ->
      // relocateTabSession -> restartTabEntry -> stopSession), so converting a
      // busy tab aborts its in-flight run and kills its dispatched children and
      // background shells. The context-menu row is already disabled for this,
      // but the row is not the only entry point: convertToWorktree is a
      // FORWARDED ATV mirror action, so it can be dispatched from the mirror
      // window against state that has since moved.
      const guard = evaluateSessionBusyGuard(get().conversationPanes.get(tabId))
      const busy = tab.status === 'running' || tab.status === 'connecting' || tab.bashExecuting || guard.blocked
      if (busy) {
        rWarn('worktree', 'convert refused: tab busy', {
          tab_id: tabId.slice(0, 8),
          tab_status: tab.status,
          bash_executing: tab.bashExecuting,
          reason: formatSessionBusyRefusal(tabId, guard, 'convert the tab to a worktree'),
        })
        return
      }

      const defaults = usePreferencesStore.getState().worktreeBranchDefaults
      const defaultBranch = defaults[tab.workingDirectory]
      if (defaultBranch) {
        const result = await window.ion.gitWorktreeAdd(tab.workingDirectory, defaultBranch)
        if (result.ok && result.worktree) {
          rInfo('worktree', 'converting tab to a worktree', {
            tab_id: tabId.slice(0, 8),
            from: tab.workingDirectory,
            to: result.worktree.worktreePath,
            branch: result.worktree.branchName,
            source_branch: defaultBranch,
          })
          // The `abc` case: a named conversation becomes a worktree, and the
          // worktree carries that same name.
          seedWorktreeFromTab(tab, result.worktree.worktreePath)
          // Same reasoning as setupWorktree: the session is already live in the
          // base repo and must be moved, not just re-labelled.
          await setTabWorkingDirectory(set, get, tabId, result.worktree.worktreePath, {
            worktree: result.worktree,
            pendingWorktreeSetup: false,
          })
          return
        }
        rWarn('worktree', 'convert refused; falling back to the branch picker', {
          tab_id: tabId.slice(0, 8), error: result.error ?? 'unknown',
        })
      }

      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, pendingWorktreeSetup: true } : t
        ),
      }))
    },

    cancelWorktreeSetup: (tabId) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, pendingWorktreeSetup: false } : t
        ),
      }))
    },

    /**
     * Rename a conversation and the worktree it lives in, to one name.
     *
     * ── Why this is a store action, not a component handler ─────────────────
     * It reads store state between mutations (rename the tab, then resolve that
     * tab's worktree to rename it too). Per the ATV rules a component handler
     * doing that would mix forwarded and mirror-local calls and decide against
     * stale mirror state — so this is ONE action, classified FORWARDED, and the
     * owner window executes both halves.
     *
     * ── Why the two halves are not "synchronization" ────────────────────────
     * Nothing here establishes an ongoing link. This is a single deliberate act
     * that happens to touch two records; afterwards they are independent again,
     * exactly as they were before. The worktree half is the same
     * operator-override IPC the git panel's rename uses, so a name applied here
     * is indistinguishable from one typed into the row.
     *
     * A tab with no worktree renames only itself — the caller gates the menu
     * item on `tab.worktree`, and this re-checks rather than trusting it.
     */
    renameTabAndWorktree: async (tabId, title) => {
      const trimmed = title.trim()
      if (!trimmed) {
        rWarn('worktree', 'combined rename refused: an empty name would blank both surfaces', {
          tab_id: tabId.slice(0, 8),
        })
        return
      }

      get().renameTab(tabId, trimmed)

      // Re-read AFTER the rename: the tab is the source of truth for which
      // worktree it lives in, and reading it again is what makes this correct in
      // the mirror rather than relying on a value captured before the mutation.
      const tab = get().tabs.find((t) => t.id === tabId)
      const worktree = tab?.worktree
      if (!worktree) {
        rDebug('worktree', 'combined rename: tab has no worktree, renamed the tab only', {
          tab_id: tabId.slice(0, 8), title: trimmed,
        })
        return
      }

      try {
        const result = await window.ion.gitWorktreeSetTitle({
          worktreePath: worktree.worktreePath,
          repoPath: worktree.repoPath,
          title: trimmed,
        })
        if (result.ok) {
          rInfo('worktree', 'renamed the conversation and its worktree', {
            tab_id: tabId.slice(0, 8),
            worktree_path: worktree.worktreePath,
            title: trimmed,
          })
        } else {
          // The tab rename already applied; only the worktree half failed, so
          // say so rather than implying nothing happened.
          rWarn('worktree', 'renamed the conversation, but the worktree rename was refused', {
            tab_id: tabId.slice(0, 8),
            worktree_path: worktree.worktreePath,
            error: result.error ?? 'unknown',
          })
        }
      } catch (err) {
        rWarn('worktree', 'renamed the conversation, but the worktree rename threw', {
          tab_id: tabId.slice(0, 8),
          worktree_path: worktree.worktreePath,
          error: String(err),
        })
      }
    },

    /**
     * Land this worktree and leave it sealed for review. Retire is deliberately
     * separate: landing must never erase the checkout the operator may inspect.
     */
    finishWorktreeTab: async (tabId, strategyOverride) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.worktree) return

      const strategy = strategyOverride || usePreferencesStore.getState().worktreeCompletionStrategy
      const { repoPath, worktreePath, branchName, sourceBranch } = tab.worktree
      const flags = landFlagsForStrategy(strategy)
      const result = await window.ion.gitWorktreeLand({
        repoPath,
        worktreePath,
        worktreeBranch: branchName,
        sourceBranch,
        noFf: flags.noFf,
        syncFirst: flags.syncFirst,
        requireFastForward: flags.requireFastForward,
      })
      if (!result.ok) {
        rWarn('worktree', 'land refused from finish-work command', {
          tab_id: tabId.slice(0, 8),
          worktree_path: worktreePath,
          error: result.error ?? '',
        })
        return
      }
      await get().sealLandedWorktree(worktreePath)
      await get().refreshWorkspaceViews(repoPath)
    },
  }
}
