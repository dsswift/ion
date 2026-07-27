import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { bumpMsgCounter } from '../session-store-helpers'
import { commitInstance } from '../conversation-instance'
import { rWarn } from '../../rendererLogger'
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

    finishWorktreeTab: async (tabId, strategyOverride) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.worktree) return

      const strategy = strategyOverride || usePreferencesStore.getState().worktreeCompletionStrategy
      const { repoPath, worktreePath, branchName, sourceBranch } = tab.worktree

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
        get().closeTab(tabId)
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
        get().closeTab(tabId)
      }
    },
  }
}
