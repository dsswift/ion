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
import type { BenchAssembleResult, IntegrationWorkspace } from '../../../shared/types'
import { rInfo, rWarn, rDebug } from '../../rendererLogger'
import {
  pickBenchConversation,
  pickDirTerminal,
  benchTerminalTitle,
} from '../../../shared/worktree-conversations'

/**
 * In-flight singleton creation, keyed by bench path. Concurrent opens (overlay
 * click + ATV click + iOS command landing in the same owner window) must not
 * race past the "no singleton exists" check into two creations; the second
 * caller awaits the first creation and focuses its result. Module-level, not
 * store state: it is owner-window-local machinery (the same pattern as
 * resume-slice-hydration), and the mirror never executes this action.
 */
const inflightBenchConversations = new Map<string, Promise<string | null>>()

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
     * Open (or focus) the bench's ONE persistent operator conversation.
     *
     * Singleton semantics: every entry point (git panel button, ATV, iOS
     * command) lands on the same tab, resolved by its stored role — never by
     * rotation through whatever conversations share the directory. Closing the
     * tab ends the singleton; the next open creates a fresh one. A pre-role
     * legacy conversation already open in the bench is adopted (stamped with
     * the role) at most once instead of duplicated.
     *
     * Concurrent opens serialize per bench through `inflightBenchConversations`
     * so two near-simultaneous requests cannot both observe "no singleton" and
     * create twins.
     */
    openBenchConversation: async (repoPath, sourceBranch) => {
      const workspaces = get().benchWorkspaces.get(repoPath) ?? []
      const ws = workspaces.find((w) => w.sourceBranch === sourceBranch)
      if (!ws) {
        rWarn('bench', 'no workspace to open', { repo_path: repoPath, source_branch: sourceBranch })
        return null
      }

      const found = pickBenchConversation(get().tabs, ws.benchPath)
      if (found) {
        if (found.adopted) {
          // Stamp the role so every later resolution is by identity, not by
          // the legacy directory heuristic. One adoption maximum by
          // construction: the next call resolves via the role.
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === found.tab.id ? { ...t, tabRole: 'bench-conversation' as const } : t)),
          }))
        }
        rInfo('bench', 'focusing bench conversation', {
          bench_path: ws.benchPath,
          tab_id: found.tab.id.slice(0, 8),
          adopted: String(found.adopted),
        })
        get().selectTab(found.tab.id)
        return found.tab.id
      }

      // Serialize creation per bench: a second caller arriving while the first
      // is still creating awaits the same promise and focuses the result.
      const inflight = inflightBenchConversations.get(ws.benchPath)
      if (inflight) {
        rInfo('bench', 'awaiting in-flight bench conversation creation', { bench_path: ws.benchPath })
        const tabId = await inflight
        if (tabId) get().selectTab(tabId)
        return tabId
      }

      const creation = (async (): Promise<string | null> => {
        // Re-check under the "lock": a singleton may have appeared between the
        // first check and this task starting (e.g. restoration finishing).
        const recheck = pickBenchConversation(get().tabs, ws.benchPath)
        if (recheck) {
          get().selectTab(recheck.tab.id)
          return recheck.tab.id
        }

        // The bench worktree may not exist on disk until the first assembly, so
        // materialise it before opening a conversation that would otherwise land
        // in a missing directory.
        if (!(await ensureBenchDirectory(repoPath, ws, get))) return null

        rInfo('bench', 'creating bench conversation', { bench_path: ws.benchPath })
        // useWorktree=false: the bench IS a worktree already and must never get
        // one nested inside it. It is also deliberately not enrolled as a member
        // of itself.
        const tabId = await get().createTabInDirectory(ws.benchPath, false, true)
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, tabRole: 'bench-conversation' as const } : t)),
        }))
        return tabId
      })()

      inflightBenchConversations.set(ws.benchPath, creation)
      try {
        return await creation
      } finally {
        inflightBenchConversations.delete(ws.benchPath)
      }
    },

    /**
     * Open (or focus) the bench's ONE dedicated terminal tab.
     *
     * Development in a bench is mostly shell work — build, test, run — and the
     * generic new-terminal path stacks a fresh tab per use, so the operator
     * accumulates identical shells and loses the scrollback they were reading.
     * This always lands on the same tab for a given bench, and the terminal
     * strip's `+` multiplexes inside it, so one tab hosts as many shells as the
     * work needs.
     *
     * Identity is derived, never stored: see `pickDirTerminal`. The consequence
     * worth naming is that closing the tab is a complete reset — the next press
     * opens a fresh one, with nothing to reconcile.
     */
    openBenchTerminal: async (repoPath, sourceBranch) => {
      const workspaces = get().benchWorkspaces.get(repoPath) ?? []
      const ws = workspaces.find((w) => w.sourceBranch === sourceBranch)
      if (!ws) {
        rWarn('bench', 'no workspace for terminal', { repo_path: repoPath, source_branch: sourceBranch })
        return null
      }

      const title = benchTerminalTitle(sourceBranch)
      const existing = pickDirTerminal(get().tabs, ws.benchPath, title)
      if (existing) {
        rInfo('bench', 'focusing existing bench terminal', {
          bench_path: ws.benchPath,
          tab_id: existing.id.slice(0, 8),
          adopted: String(existing.customTitle !== title),
        })
        get().selectTab(existing.id)
        // Tier-2 hit: a terminal that was already in the bench directory but
        // not named by Ion. Name it so the next press matches on tier 1 — but
        // only when the operator has not titled it themselves, because their
        // name is the one thing here we must never overwrite.
        if (!existing.customTitle) get().renameTab(existing.id, title)
        return existing.id
      }

      // No terminal yet, so the directory has to be real before one opens in
      // it. A shell whose cwd does not exist is the defect, not a fallback.
      if (!(await ensureBenchDirectory(repoPath, ws, get))) return null

      const tabId = await get().createTerminalTab(ws.benchPath)
      get().renameTab(tabId, title)
      rInfo('bench', 'opened bench terminal', {
        bench_path: ws.benchPath,
        tab_id: tabId.slice(0, 8),
      })
      return tabId
    },

    benchAssemble: async (repoPath, sourceBranch) => {
      rInfo('bench', 'assemble requested', { source_branch: sourceBranch })
      const result = await window.ion.benchAssemble(repoPath, sourceBranch)
      if (!result.ok) {
        // A typed refusal is the machinery protecting an in-flight state (an
        // open resolution merge, a dirty bench) — expected, not a failure.
        if (result.refusal) rInfo('bench', 'assemble refused', { refusal: result.refusal, detail: result.error ?? '' })
        else rWarn('bench', 'assemble failed', { error: result.error ?? '' })
      } else if (result.workspace?.lastAssembly === 'failed') {
        rWarn('bench', 'assembly failed atomically', { error: result.workspace.lastAssemblyError ?? '' })
      }
      recordRetired(set, repoPath, sourceBranch, result)
      await get().refreshBench(repoPath)
      return result
    },

    /**
     * Resolve-once flow (ATV multi-step rule: ONE forwarded action). The main
     * process re-creates the failed assembly merge and leaves it in progress;
     * the returned bench path is where the caller opens the ConflictsDialog.
     * When recordings already cover every hunk, nothing is left to resolve —
     * reassemble instead and return null so no dialog opens over a clean bench.
     */
    benchResolveConflict: async (repoPath, sourceBranch) => {
      rInfo('bench', 'resolve conflict requested', { source_branch: sourceBranch })
      const prepared = await window.ion.benchResolveConflict(repoPath, sourceBranch)
      if (!prepared.ok) {
        rWarn('bench', 'resolve preparation failed', { error: prepared.error ?? '' })
        return null
      }
      if (!prepared.branchName) {
        // No merge was left open: recordings (or a pin change) already cover
        // the conflict, so a plain assembly completes the job.
        rInfo('bench', 'no conflict remains, reassembling', { source_branch: sourceBranch })
        await get().benchAssemble(repoPath, sourceBranch)
        return null
      }
      rInfo('bench', 'merge left in progress for resolution', {
        bench_path: prepared.benchPath ?? '',
        branch: prepared.branchName,
      })
      return prepared.benchPath ?? null
    },

    benchRerereCount: async (directory) => {
      const result = await window.ion.benchRerereCount(directory)
      if (!result.ok) throw new Error(result.error ?? 'Could not count conflict recordings')
      return result.count
    },

    benchRerereForget: async (directory, paths) => {
      const result = await window.ion.benchRerereForget(directory, paths)
      if (!result.ok) throw new Error(result.error ?? 'Could not forget conflict recordings')
      rInfo('bench', 'forgot selected conflict recordings', { directory, count: result.count })
      return result.count
    },

    benchRerereDiscardAll: async (directory) => {
      const result = await window.ion.benchRerereDiscardAll(directory)
      if (!result.ok) throw new Error(result.error ?? 'Could not discard conflict recordings')
      rInfo('bench', 'discarded all conflict recordings', { directory, count: result.count })
      return result.count
    },

    benchUpdateMember: async (repoPath, sourceBranch, worktreePath) => {
      rInfo('bench', 'update member', { worktree_path: worktreePath })
      const result = await window.ion.benchUpdateMember({ repoPath, sourceBranch, worktreePath })
      if (!result.ok) rWarn('bench', 'update member failed', { error: result.error ?? '' })
      if (result.warning) rWarn('bench', 'update predicts a collision', { warning: result.warning })
      recordRetired(set, repoPath, sourceBranch, result)
      await get().refreshBench(repoPath)
      return result
    },

    benchUpdateAll: async (repoPath, sourceBranch) => {
      rInfo('bench', 'update all stale', { source_branch: sourceBranch })
      const result = await window.ion.benchUpdateAll(repoPath, sourceBranch)
      if (!result.ok) rWarn('bench', 'update all failed', { error: result.error ?? '' })
      if (result.warning) rWarn('bench', 'update-all predicts a collision', { warning: result.warning })
      recordRetired(set, repoPath, sourceBranch, result)
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

    benchSetReview: async (repoPath, sourceBranch, worktreePath, review) => {
      rInfo('bench', 'member review set', { worktree_path: worktreePath, review: review ?? 'none' })
      await window.ion.benchSetReview({ repoPath, sourceBranch, worktreePath, review })
      await get().refreshBench(repoPath)
    },

    benchSetOrder: async (repoPath, sourceBranch, worktreePath, toIndex) => {
      rInfo('bench', 'member order set', { worktree_path: worktreePath, to_index: toIndex })
      await window.ion.benchSetOrder({ repoPath, sourceBranch, worktreePath, toIndex })
      await get().refreshBench(repoPath)
    },

    clearBenchRetired: (repoPath, sourceBranch) => {
      rDebug('bench', 'absorbed notice dismissed', { repo_path: repoPath, source_branch: sourceBranch })
      set((s) => {
        const forRepo = s.benchRetired.get(repoPath)
        if (!forRepo || !forRepo.has(sourceBranch)) return {}
        const nextForRepo = new Map(forRepo)
        nextForRepo.delete(sourceBranch)
        return { benchRetired: new Map(s.benchRetired).set(repoPath, nextForRepo) }
      })
    },
  }
}

/**
 * Make sure the bench directory exists on disk, building it when it does not.
 *
 * Returns false when the bench could not be materialised, which the callers
 * treat as "do not open anything" — landing a conversation or a shell in a
 * directory that is not there produces an engine session with a dead cwd, which
 * fails later and further from the cause.
 *
 * ── Two reasons the directory can be missing ────────────────────────────────
 * `lastBuiltAt === 0` is the first-run case: enrollment creates the workspace
 * RECORD, and the first assembly is what creates the directory. That check alone
 * was the previous behaviour and it is not sufficient — a bench that HAS been
 * built can still have its directory removed out from under Ion (deleted by
 * hand, pruned with `git worktree prune`, a wiped `~/.ion/integration`), and the
 * record keeps its build timestamp. So existence is checked too, and either
 * answer triggers the same assembly.
 */
async function ensureBenchDirectory(
  repoPath: string,
  ws: IntegrationWorkspace,
  get: StoreGet,
): Promise<boolean> {
  const neverBuilt = ws.lastBuiltAt === 0
  // Only worth an IPC round trip when the record claims a build happened.
  const missing = neverBuilt || !(await window.ion.fsExists(ws.benchPath)).exists
  if (!missing) return true

  rInfo('bench', 'materialising bench directory before use', {
    repo_path: repoPath,
    source_branch: ws.sourceBranch,
    bench_path: ws.benchPath,
    reason: neverBuilt ? 'never_built' : 'directory_gone',
  })
  const built = await window.ion.benchAssemble(repoPath, ws.sourceBranch)
  if (!built.ok) {
    rWarn('bench', 'bench build failed; nothing opened', {
      source_branch: ws.sourceBranch,
      error: built.error ?? '',
    })
    return false
  }
  await get().refreshBench(repoPath)
  return true
}

/**
 * Record the members an assembly absorbed into the base so the section can say what
 * happened.
 *
 * A retired member's row disappears from the list, and a row vanishing with no
 * explanation is indistinguishable from the bench losing a worktree — which is
 * exactly how the pending-member defect was first reported. An empty or absent
 * `retired` list clears any previous notice rather than leaving a stale one on
 * screen.
 */
function recordRetired(
  set: StoreSet,
  repoPath: string,
  sourceBranch: string,
  result: BenchAssembleResult,
): void {
  const absorbed = result.retired ?? []
  if (absorbed.length > 0) {
    rInfo('bench', 'members absorbed into base', {
      repo_path: repoPath,
      source_branch: sourceBranch,
      count: absorbed.length,
      branches: absorbed.map((m) => m.branchName).join(','),
    })
  }
  set((s) => {
    const forRepo = new Map(s.benchRetired.get(repoPath) ?? [])
    if (absorbed.length > 0) forRepo.set(sourceBranch, absorbed)
    else forRepo.delete(sourceBranch)
    return { benchRetired: new Map(s.benchRetired).set(repoPath, forRepo) }
  })
}
