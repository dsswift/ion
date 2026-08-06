import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { bumpMsgCounter } from '../session-store-helpers'
import { commitInstance } from '../conversation-instance'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'
import { seedWorktreeFromTab } from './event-slice-titling'
import { setTabWorkingDirectory } from './tab-working-directory'
import { closeOccupants, resolveRetireBlockers } from './worktree-occupant-close'

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

      const defaults = usePreferencesStore.getState().worktreeBranchDefaults
      const defaultBranch = defaults[tab.workingDirectory]
      if (defaultBranch) {
        const result = await window.ion.gitWorktreeAdd(tab.workingDirectory, defaultBranch)
        if (result.ok && result.worktree) {
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
     * Land this worktree's work and then retire the worktree.
     *
     * ── Why the guard pre-flight is the FIRST thing here ─────────────────────
     * This action ends in a retire, which deletes the worktree directory. Every
     * conversation living there — not just this tab — is closed by that, and
     * `closeTab` refuses a tab that is still running (see tab-close-guard.ts).
     * Checking after the land would be too late in the worst way: the work would
     * already be merged into the source branch and the worktree half-removed,
     * with no way to answer "so is this finished or not?". So the check runs
     * before anything is landed, pushed, or removed, and the refusal names the
     * conversations so the operator can decide whether to interrupt or wait.
     *
     * ── Why it closes ALL occupants, not just `tabId` ────────────────────────
     * This used to end in `closeTab(tabId)`, which left every sibling
     * conversation in the same worktree pointed at a deleted directory — the
     * same defect the retire path had.
     */
    finishWorktreeTab: async (tabId, strategyOverride) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.worktree) return

      const strategy = strategyOverride || usePreferencesStore.getState().worktreeCompletionStrategy
      const { repoPath, worktreePath, branchName, sourceBranch } = tab.worktree

      // Which other directories would the closing retire delete? Same source of
      // truth as the retire itself, so the check cannot miss a bench.
      let benchPaths: string[] = []
      try {
        const preview = await window.ion.gitWorktreeRetirePreview(worktreePath)
        benchPaths = preview.prunedBenchPaths ?? []
      } catch (err) {
        rWarn('worktree', 'retire preview failed; checking the worktree only', {
          worktree_path: worktreePath, error: String(err),
        })
      }

      const blockers = resolveRetireBlockers(get, worktreePath, benchPaths)
      if (blockers) {
        // Nothing landed, nothing pushed, nothing removed. Report through the
        // same system-message channel the refused-retire arms below use.
        set((s) => ({
          conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
            ...inst,
            messages: [...inst.messages, { id: `msg-${bumpMsgCounter()}`, role: 'system' as const, content: blockers.error, timestamp: Date.now() }],
          })),
        }))
        rWarn('worktree', 'finish refused: active work in the worktree', {
          tab_id: tabId.slice(0, 8), worktree_path: worktreePath, active_count: blockers.active.length,
        })
        return
      }

      if (strategy === 'merge-ff' || strategy === 'merge') {
        const noFf = strategy === 'merge'
        const result = await window.ion.gitWorktreeMerge(repoPath, branchName, sourceBranch, noFf)
        if (!result.ok) {
          const msg = result.hasConflicts
            ? `Merge conflict: resolve manually in ${repoPath} then close this tab.`
            : `Merge failed: ${result.error}`
          // System message appends onto the active conversation instance now.
          set((s) => ({
            conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
              ...inst,
              messages: [...inst.messages, { id: `msg-${bumpMsgCounter()}`, role: 'system' as const, content: msg, timestamp: Date.now() }],
            })),
          }))
          return
        }
        // Retire through the appraised path, never a blind force-remove. The
        // land above succeeded, so the worktree SHOULD be safe to retire — but
        // "should" is not a guarantee: an agent may have written files between
        // the land and this call. retireWorktree asks git what would actually
        // be lost and refuses when the answer is "work", so a surprise leaves
        // an extra directory behind instead of destroying changes.
        const retire = await window.ion.gitWorktreeRetire({ repoPath, worktreePath, branchName })
        if (!retire.ok) {
          set((s) => ({
            conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
              ...inst,
              messages: [...inst.messages, { id: `msg-${bumpMsgCounter()}`, role: 'system' as const, content: `Landed successfully. The worktree was kept: ${retire.error}`, timestamp: Date.now() }],
            })),
          }))
          rWarn('worktree', 'retire refused after land; worktree kept', { worktreePath, error: retire.error ?? '' })
          return
        }
        // Close EVERY conversation in the retired directories, not just this
        // tab: the worktree (and any bench the retire pruned) is gone, so a
        // sibling conversation left open would be pointed at nothing.
        await closeOccupants(set, get, [worktreePath, ...(retire.prunedBenchPaths ?? [])], retire.workingDirectory)
      } else {
        const pushResult = await window.ion.gitWorktreePush(worktreePath, sourceBranch)
        if (!pushResult.ok) {
          // System message appends onto the active conversation instance now.
          set((s) => ({
            conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
              ...inst,
              messages: [...inst.messages, { id: `msg-${bumpMsgCounter()}`, role: 'system' as const, content: `Push failed: ${pushResult.error}`, timestamp: Date.now() }],
            })),
          }))
          return
        }
        if (pushResult.remoteUrl && pushResult.remoteBranch) {
          const url = pushResult.remoteUrl
            .replace(/\.git$/, '')
            .replace(/^git@([^:]+):/, 'https://$1/')
          window.ion.openExternal(`${url}/compare/${sourceBranch}...${pushResult.remoteBranch}`).catch((err) => rWarn('worktree', 'openExternal compare URL failed', { error: String(err) }))
        }
        // Retire through the appraised path, never a blind force-remove. The
        // land above succeeded, so the worktree SHOULD be safe to retire — but
        // "should" is not a guarantee: an agent may have written files between
        // the land and this call. retireWorktree asks git what would actually
        // be lost and refuses when the answer is "work", so a surprise leaves
        // an extra directory behind instead of destroying changes.
        const retire = await window.ion.gitWorktreeRetire({ repoPath, worktreePath, branchName })
        if (!retire.ok) {
          set((s) => ({
            conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
              ...inst,
              messages: [...inst.messages, { id: `msg-${bumpMsgCounter()}`, role: 'system' as const, content: `Landed successfully. The worktree was kept: ${retire.error}`, timestamp: Date.now() }],
            })),
          }))
          rWarn('worktree', 'retire refused after land; worktree kept', { worktreePath, error: retire.error ?? '' })
          return
        }
        // Same as the merge arm: the directories are gone, so every conversation
        // in them closes — a `closeTab(tabId)` here would orphan the siblings.
        await closeOccupants(set, get, [worktreePath, ...(retire.prunedBenchPaths ?? [])], retire.workingDirectory)
      }
    },
  }
}
