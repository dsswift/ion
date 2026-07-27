/**
 * Integration workspace (bench) store slice.
 *
 * Thin forwarders to the main process, which owns the workspace record. The
 * renderer holds a read model only, so overlay, ATV mirror, and iOS cannot
 * drift: they all render the same main-process truth.
 *
 * Multi-step flows live here as single actions (per AGENTS.md § ATV shell
 * rules) rather than in component handlers, which would run in whichever window
 * hosts them and decide against stale mirror state.
 */
import type { StoreSet, StoreGet, State } from '../session-store-types'
import type { IntegrationWorkspace } from '../../../shared/types'
import { rInfo, rWarn, rDebug } from '../../rendererLogger'

export function createBenchSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    refreshBench: async (repoPath) => {
      if (!repoPath || repoPath === '~') return
      try {
        const { workspaces, tips } = await window.ion.benchList(repoPath)
        // Refresh staleness for each workspace so the view is correct the
        // moment it renders (view-readiness), not a beat later.
        const refreshed: IntegrationWorkspace[] = []
        for (const ws of workspaces) {
          const { workspace } = await window.ion.benchRefreshStaleness(repoPath, ws.sourceBranch)
          refreshed.push(workspace ?? ws)
        }
        set((s) => ({
          benchWorkspaces: new Map(s.benchWorkspaces).set(repoPath, refreshed),
          benchSourceTips: new Map(s.benchSourceTips).set(repoPath, tips),
        }))
        rDebug('bench', 'refreshed', { repo_path: repoPath, count: refreshed.length })
      } catch (err) {
        rWarn('bench', 'refresh failed', { repo_path: repoPath, error: String(err) })
      }
    },

    /**
     * Open (or focus) a conversation in the bench worktree.
     *
     * This is the "talk to the bench" entry point: run the build, diagnose a
     * cross-feature failure, discuss. The bench is an ordinary directory, so a
     * normal conversation works — but the operator should never have to know
     * or type the `~/.ion/integration/...` path.
     *
     * Focuses an existing bench tab rather than stacking duplicates, matching
     * the worktree re-entry behaviour.
     */
    openBenchConversation: async (repoPath, sourceBranch) => {
      const workspaces = get().benchWorkspaces.get(repoPath) ?? []
      const ws = workspaces.find((w) => w.sourceBranch === sourceBranch)
      if (!ws) {
        rWarn('bench', 'no workspace to open', { repo_path: repoPath, source_branch: sourceBranch })
        return null
      }

      const existing = get().tabs.find((t) => t.workingDirectory === ws.benchPath)
      if (existing) {
        rInfo('bench', 'focusing existing bench conversation', { tab_id: existing.id.slice(0, 8) })
        get().selectTab(existing.id)
        return existing.id
      }

      // The bench worktree may not exist on disk until the first rebuild, so
      // materialise it before opening a conversation that would otherwise land
      // in a missing directory.
      if (ws.lastBuiltAt === 0) {
        rInfo('bench', 'bench never built; building before opening', { source_branch: sourceBranch })
        const built = await window.ion.benchRebuild(repoPath, sourceBranch)
        if (!built.ok) {
          rWarn('bench', 'cannot open conversation, build failed', { error: built.error ?? '' })
          return null
        }
        await get().refreshBench(repoPath)
      }

      rInfo('bench', 'opening bench conversation', { bench_path: ws.benchPath })
      // useWorktree=false: the bench IS a worktree already and must never get
      // one nested inside it. It is also deliberately not enrolled as a member
      // of itself.
      return get().createTabInDirectory(ws.benchPath, false, true)
    },

    benchRebuild: async (repoPath, sourceBranch) => {
      rInfo('bench', 'rebuild requested', { source_branch: sourceBranch })
      const result = await window.ion.benchRebuild(repoPath, sourceBranch)
      if (!result.ok) rWarn('bench', 'rebuild failed', { error: result.error ?? '' })
      await get().refreshBench(repoPath)
      return result
    },

    benchUpdateMember: async (repoPath, sourceBranch, worktreePath) => {
      rInfo('bench', 'update member', { worktree_path: worktreePath })
      const result = await window.ion.benchUpdateMember({ repoPath, sourceBranch, worktreePath })
      if (!result.ok) rWarn('bench', 'update member failed', { error: result.error ?? '' })
      await get().refreshBench(repoPath)
      return result
    },

    benchUpdateAll: async (repoPath, sourceBranch) => {
      rInfo('bench', 'update all stale', { source_branch: sourceBranch })
      const result = await window.ion.benchUpdateAll(repoPath, sourceBranch)
      if (!result.ok) rWarn('bench', 'update all failed', { error: result.error ?? '' })
      await get().refreshBench(repoPath)
      return result
    },

    benchAddMember: async (repoPath, sourceBranch, worktreePath, branchName) => {
      const result = await window.ion.benchAddMember({ repoPath, sourceBranch, worktreePath, branchName })
      if (!result.ok) rWarn('bench', 'add member refused', { branch: branchName, error: result.error ?? '' })
      await get().refreshBench(repoPath)
      return result
    },

    benchRemoveMember: async (repoPath, sourceBranch, worktreePath) => {
      rInfo('bench', 'remove member', { worktree_path: worktreePath })
      await window.ion.benchRemoveMember({ repoPath, sourceBranch, worktreePath })
      await get().refreshBench(repoPath)
    },

    benchSetEnabled: async (repoPath, sourceBranch, worktreePath, enabled) => {
      await window.ion.benchSetEnabled({ repoPath, sourceBranch, worktreePath, enabled })
      await get().refreshBench(repoPath)
    },
  }
}
