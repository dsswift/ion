import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'

export function createDirectorySlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    addDirectory: (dir) => {
      const { activeTabId } = get()
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                additionalDirs: t.additionalDirs.includes(dir)
                  ? t.additionalDirs
                  : [...t.additionalDirs, dir],
              }
            : t
        ),
      }))
    },

    removeDirectory: (dir) => {
      const { activeTabId } = get()
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === activeTabId
            ? { ...t, additionalDirs: t.additionalDirs.filter((d) => d !== dir) }
            : t
        ),
      }))
    },

    setBaseDirectory: (dir) => {
      usePreferencesStore.getState().addRecentBaseDirectory(dir)
      usePreferencesStore.getState().incrementDirectoryUsage(dir)
      const { activeTabId } = get()
      const tab = get().tabs.find((t) => t.id === activeTabId)

      if (tab?.worktree && tab.messages.length === 0) {
        window.ion.gitWorktreeRemove(
          tab.worktree.repoPath,
          tab.worktree.worktreePath,
          tab.worktree.branchName,
          true,
        ).catch(() => {})
      }

      window.ion.resetTabSession(activeTabId)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                workingDirectory: dir,
                hasChosenDirectory: true,
                historicalSessionIds: [],
                conversationId: null,
                additionalDirs: [],
                worktree: null,
                pendingWorktreeSetup: false,
              }
            : t
        ),
      }))

      const gitOpsMode = usePreferencesStore.getState().gitOpsMode
      if (gitOpsMode === 'worktree') {
        window.ion.gitIsRepo(dir).then(({ isRepo }) => {
          if (!isRepo) return
          const defaults = usePreferencesStore.getState().worktreeBranchDefaults
          const defaultBranch = defaults[dir]
          if (defaultBranch) {
            window.ion.gitWorktreeAdd(dir, defaultBranch).then((result) => {
              if (result.ok && result.worktree) {
                set((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === activeTabId
                      ? { ...t, worktree: result.worktree!, workingDirectory: result.worktree!.worktreePath }
                      : t
                  ),
                }))
              }
            })
          } else {
            set((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === activeTabId ? { ...t, pendingWorktreeSetup: true } : t
              ),
            }))
          }
        })
      }
    },
  }
}
