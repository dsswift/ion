import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { bumpMsgCounter } from '../session-store-helpers'

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
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  worktree: result.worktree!,
                  workingDirectory: result.worktree!.worktreePath,
                  pendingWorktreeSetup: false,
                }
              : t
          ),
        }))
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
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    worktree: result.worktree!,
                    workingDirectory: result.worktree!.worktreePath,
                    pendingWorktreeSetup: false,
                  }
                : t
            ),
          }))
          return
        }
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

      if (strategy === 'merge') {
        const result = await window.ion.gitWorktreeMerge(repoPath, branchName, sourceBranch)
        if (!result.ok) {
          const msg = result.hasConflicts
            ? `Merge conflict: resolve manually in ${repoPath} then close this tab.`
            : `Merge failed: ${result.error}`
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tabId
                ? { ...t, messages: [...t.messages, { id: `msg-${bumpMsgCounter()}`, role: 'system' as const, content: msg, timestamp: Date.now() }] }
                : t
            ),
          }))
          return
        }
        await window.ion.gitWorktreeRemove(repoPath, worktreePath, branchName, true).catch(() => {})
        get().closeTab(tabId)
      } else {
        const pushResult = await window.ion.gitWorktreePush(worktreePath, sourceBranch)
        if (!pushResult.ok) {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tabId
                ? { ...t, messages: [...t.messages, { id: `msg-${bumpMsgCounter()}`, role: 'system' as const, content: `Push failed: ${pushResult.error}`, timestamp: Date.now() }] }
                : t
            ),
          }))
          return
        }
        if (pushResult.remoteUrl && pushResult.remoteBranch) {
          const url = pushResult.remoteUrl
            .replace(/\.git$/, '')
            .replace(/^git@([^:]+):/, 'https://$1/')
          window.ion.openExternal(`${url}/compare/${sourceBranch}...${pushResult.remoteBranch}`)
        }
        await window.ion.gitWorktreeRemove(repoPath, worktreePath, branchName, true).catch(() => {})
        get().closeTab(tabId)
      }
    },
  }
}
