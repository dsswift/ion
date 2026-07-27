import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { activeInstance, instanceMessageCount } from '../conversation-instance'
import { rInfo, rWarn } from '../../rendererLogger'

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
      const s = get()
      const tab = s.tabs.find((t) => t.id === activeTabId)

      // Changing the base directory does NOT remove the tab's worktree, even
      // when the conversation has no messages yet.
      //
      // This used to call gitWorktreeRemove(..., force = true) for an
      // "empty" worktree conversation, inferring from a zero message count
      // that the worktree was disposable. That inference is unsound: an agent
      // can commit work without the conversation accumulating messages, and a
      // worktree created moments ago may already hold a branch the operator
      // cares about. Message count is not a proxy for "contains no work".
      //
      // Worktree removal is its own explicit verb ("Retire"), gated by an
      // appraisal that asks git what would actually be lost
      // (main/worktree/safety.ts). Leaving an unused worktree behind costs a
      // directory the operator can retire deliberately; removing one that held
      // work costs the work.
      if (tab?.worktree) {
        rInfo('worktree', 'base directory changed; worktree preserved', {
          tab_id: tab.id,
          worktree_path: tab.worktree.worktreePath,
          branch: tab.worktree.branchName,
          message_count: instanceMessageCount(activeInstance(s.conversationPanes, tab.id)),
        })
      }

      // setBaseDirectory intentionally starts a FRESH conversation in the new
      // directory: the renderer state below nulls conversationId and clears
      // historicalSessionIds. So the destructive resetTabSession (which also
      // nulls the engine-side conversationId and forces a fresh mint) is the
      // CORRECT primitive here — engine and renderer stay consistent. This is
      // distinct from stuck-tab recovery, which must PRESERVE the conversation
      // and therefore uses restartTabSession.
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
            }).catch((err) => rWarn('directory', 'gitWorktreeAdd failed', { dir, branch: defaultBranch, error: String(err) }))
          } else {
            set((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === activeTabId ? { ...t, pendingWorktreeSetup: true } : t
              ),
            }))
          }
        }).catch((err) => rWarn('directory', 'gitIsRepo probe failed', { dir, error: String(err) }))
      }
    },
  }
}
