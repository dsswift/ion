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
import { closeOccupants, resolveRetireBlockers } from './worktree-occupant-close'
import { legacyReviewToStage } from '../../../shared/types-git'
import { collectAllDirConversations, pickNextConversation } from '../../../shared/worktree-conversations'
import { resolveRegisteredWorktree } from '../worktree-registration'

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
        // Alerts ride the same refresh, with kind-aware lifecycles:
        //  - conflicts: recorded while an operation is in progress (covers
        //    conflicts raised outside a sync click — a restart, a manual
        //    rebase), cleared when the operation finishes;
        //  - refusals ("dirty worktree, sync declined"): no git state says
        //    "was refused", so they clear when the worktree goes CLEAN or a
        //    sync succeeds — clearing them on "no operation" would wipe the
        //    alert on the very refresh that follows the refusal.
        for (const wt of worktrees) {
          if (wt.operationState) {
            get().recordConflictAlert(wt.worktreePath, {
              source: 'detected',
              operationState: wt.operationState,
              label: wt.label,
            })
          } else {
            const alert = get().gitConflictAlerts.get(wt.worktreePath)
            if (alert?.kind === 'refusal') {
              if (!wt.isDirty) get().clearConflictAlert(wt.worktreePath)
            } else {
              get().clearConflictAlert(wt.worktreePath)
            }
          }
        }
        rDebug('worktree.inventory', 'refreshed', { repo_path: repoPath, count: worktrees.length })
      } catch (err) {
        rWarn('worktree.inventory', 'refresh failed', { repo_path: repoPath, error: String(err) })
      }
    },

    /**
     * Re-read both worktree surfaces for a repo: the inventory and the bench.
     *
     * ── Why this exists as ONE named action ─────────────────────────────────
     * Any flow that changes git state a worktree row describes has to refresh
     * both caches, because the row is a join of them — the inventory carries
     * dirty/unlanded/operationState, the bench record carries pin and merge
     * verdicts, and a row showing a stale conflict badge after a resolution is
     * the visible cost of refreshing only one. The auto-fix close path forgot
     * both entirely (it called `closeTab` and nothing else), which left the red
     * badge up until the panel's 5s poll happened to fire.
     *
     * Naming the pair keeps the next caller from re-deriving it: two ad-hoc
     * call sites are two chances to refresh one and forget the other.
     *
     * Deliberately NOT a reassembly. Refreshing reads git and the records;
     * reassembling MUTATES the bench and carries its own refusal semantics. A
     * post-resolution refresh must never rebuild — the operator decides when a
     * rebuild is the right move.
     *
     * `allSettled`: both actions log their own failures, and one failing must
     * not skip the other. Read-only IPC into per-window derived caches, so it
     * is mirror-local by classification (see atv-mirror-actions.ts).
     */
    refreshWorkspaceViews: async (repoPath) => {
      if (!repoPath || repoPath === '~') {
        rDebug('worktree.inventory', 'workspace refresh skipped: no repo path', { repo_path: repoPath })
        return
      }
      const [inventory, bench] = await Promise.allSettled([
        get().refreshWorktreeInventory(repoPath),
        get().refreshBench(repoPath),
      ])
      rDebug('worktree.inventory', 'workspace views refreshed', {
        repo_path: repoPath,
        inventory: inventory.status,
        bench: bench.status,
      })
    },

    /**
     * Create an ADDITIONAL conversation in a worktree, always a new one.
     *
     * ── Why this is a store action and not a component handler ───────────────
     * Creating the tab is only half the job: the tab must also be given its
     * `worktree` metadata, or it reads as a plain directory conversation. That
     * matters well beyond the lifecycle verbs — the git panel resolves which
     * repo's worktrees to list THROUGH that metadata, so a tab without it lists
     * the worktree's own `git worktree list` (main clone included, no registry,
     * no bench) instead of the repo's worktrees.
     *
     * The row menu's "New conversation here" originally called
     * `createTabInDirectory` directly and skipped the attachment, which produced
     * exactly that: a second conversation in a worktree showed a different, wrong
     * worktree panel from the first. Both paths now share this one action, so the
     * attachment cannot be forgotten by a caller again.
     */
    newWorktreeConversation: async (worktreePath) => {
      rInfo('worktree.inventory', 'opening new conversation in worktree', { worktree_path: worktreePath })
      // createTabInDirectory with useWorktree=false: the worktree already
      // exists, so this must NOT create another one inside it.
      // skipDuplicateCheck=true: an additional conversation here is the request.
      const tabId = await get().createTabInDirectory(worktreePath, false, true)

      // Attach the worktree metadata so the tab gets the worktree affordances
      // (land, sync, retire) AND so the git panel can resolve its owning repo.
      //
      // ── Ask the REGISTRY, never the inventory cache ─────────────────────────
      // This used to derive `repoPath` by scanning `worktreeInventory.keys()` for
      // a map whose value list contained this worktree. That map is a DISPLAY
      // cache keyed by whatever path the panel last queried -- and from a bench
      // conversation, that key is the BENCH path. So the scan happily returned
      // the bench as this worktree's owning repo and wrote it onto the tab.
      //
      // The symptom was three conversations in one worktree disagreeing about
      // what the worktree panel should show: one correct, one claiming the bench
      // as its repo, one with no metadata at all. A wrong repoPath is worse than
      // a missing one, because the panel then confidently lists that directory's
      // own `git worktree list` -- main clone included.
      //
      // The registry records the true repo at creation and is the only
      // authoritative source. A heuristic scan over a cache keyed for display is
      // exactly the substitution that drifts.
      const worktree = await resolveRegisteredWorktree(worktreePath)
      if (worktree) {
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === tabId
            ? { ...t, worktree }
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
     * Open a conversation in a worktree — the re-entry path after a tab close,
     * and the way to cycle through the conversations already living there.
     *
     * If conversations are ALREADY open on that worktree, focus one instead of
     * creating another: without this the operator accumulates duplicates in one
     * worktree, which is the problem the inventory exists to solve.
     *
     * When SEVERAL are open, each click advances to the next one (wrapping).
     * This used to `find(...)` the first match and re-select it forever, so
     * every conversation after the first was unreachable from the row. The
     * rotation is stateless — it reads the currently active tab and steps past
     * it — so there is no cursor for the overlay and the ATV mirror to disagree
     * about, and closing a tab cannot leave it dangling.
     *
     * The cycle is ALL-INCLUSIVE — `collectAllDirConversations`, not the
     * operator-only `collectDirConversations` every display surface uses. A
     * `conflict-auto-fix` conversation is still open work in this worktree; if
     * it moved tab groups or the operator just needs to check it, the row click
     * is the only path back in that does not require hunting through the
     * strip. Excluding it here (as the display surfaces correctly do) would
     * make it permanently unreachable from the worktree that owns it.
     */
    openWorktreeConversation: async (worktreePath) => {
      const matches = collectAllDirConversations(get().tabs, worktreePath)
      const next = pickNextConversation(matches, get().activeTabId)
      if (next) {
        rInfo('worktree.inventory', 'focusing existing conversation for worktree', {
          worktree_path: worktreePath,
          match_count: matches.length,
          from_tab: (get().activeTabId ?? 'none').slice(0, 8),
          to_tab: next.tabId.slice(0, 8),
        })
        get().selectTab(next.tabId)
        return next.tabId
      }

      return get().newWorktreeConversation(worktreePath)
    },

    /**
     * Retire a worktree: refuse while anything in it is still working, then
     * close every conversation that lived there.
     *
     * ── Why this is a store action, not a component handler ─────────────────
     * It reads store state between mutations (which tabs occupy this worktree,
     * are any of them busy, then close them). Per AGENTS.md § ATV shell rules a
     * component handler doing that would mix forwarded and local calls in the
     * mirror and decide against stale mirror state.
     *
     * ── Why the guard check comes before the IPC ─────────────────────────────
     * `closeTab` refuses a tab whose orchestrator is running, whose dispatched
     * background agents are alive, or which has outstanding background bash
     * commands — and there is deliberately no `force`, because forcing would
     * SIGTERM those agents. So the check cannot come after the removal: the
     * refusals would land once the directory was already gone, leaving live work
     * writing into nothing. Instead the whole retire is refused while anything
     * is active, and the refusal NAMES the tabs so the operator can go find
     * them. Whether to interrupt or wait is theirs to decide; that work may
     * matter and Ion does not get to end it on their behalf.
     *
     * ── Why the conversations are CLOSED, not relocated ──────────────────────
     * This used to relocate the first occupant to the repo root and ignore every
     * other tab in the worktree. Both halves were wrong. `find` left the rest
     * pointed at a deleted directory, and relocation is not what retire means:
     * the work is done or abandoned and its place is gone, so there is nothing
     * at the repo root for that conversation to continue. New work starts as a
     * new conversation in a new worktree.
     *
     * The bench paths matter for the same reason — retiring the last member of a
     * bench removes that bench's worktree too, and conversations live there. The
     * pre-flight uses the PREDICTED set (before anything is touched) and the
     * close uses the REAL set the retire reports.
     */
    retireWorktree: async (repoPath, worktreePath, branchName) => {
      // Which OTHER directories would this retire delete? Asked of the main
      // process rather than derived here: the emptiness rule lives with
      // `disenrollWorktree`, and a second copy in the renderer would drift.
      let benchPaths: string[] = []
      try {
        const preview = await window.ion.gitWorktreeRetirePreview(worktreePath)
        benchPaths = preview.prunedBenchPaths ?? []
      } catch (err) {
        // Fail SAFE on the pre-flight's scope, not open: with no prediction the
        // worktree's own occupants are still checked and closed. A bench tab
        // could be missed, so this is logged at WARN rather than swallowed.
        rWarn('worktree.inventory', 'retire preview failed; checking the worktree only', {
          worktree_path: worktreePath, error: String(err),
        })
      }

      const blockers = resolveRetireBlockers(get, worktreePath, benchPaths)
      if (blockers) {
        // Nothing on disk has been touched. Refresh so the row reflects current
        // state, and hand the named refusal back for the caller to render.
        await get().refreshWorktreeInventory(repoPath)
        return { ok: false, error: blockers.error }
      }

      rInfo('worktree.inventory', 'retire requested', {
        worktree_path: worktreePath,
        branch: branchName,
        bench_paths: benchPaths.length,
      })

      const result = await window.ion.gitWorktreeRetire({
        repoPath,
        worktreePath,
        branchName,
        // Force only after the caller confirmed against a concrete appraisal.
        force: true,
      })

      if (!result.ok) {
        rWarn('worktree.inventory', 'retire refused; nothing closed', {
          worktree_path: worktreePath, error: result.error ?? '',
        })
        await get().refreshWorktreeInventory(repoPath)
        return result
      }

      // The directories are gone. Close their conversations, keeping the repo
      // root only as the fallback for a tab that became busy in the window
      // between the pre-flight and the removal.
      await closeOccupants(
        set,
        get,
        [worktreePath, ...(result.prunedBenchPaths ?? [])],
        result.workingDirectory,
      )

      await get().refreshWorktreeInventory(repoPath)
      return result
    },

    /**
     * Re-run provisioning for a worktree, then refresh so the row reflects the
     * new state.
     *
     * A store action rather than a component handler because it mutates
     * owner-side state and then reads it back through the inventory — the
     * pattern the ATV mirror rules require (a handler would run locally in the
     * mirror and decide against stale state).
     */
    reprovisionWorktree: async (repoPath, worktreePath) => {
      rInfo('worktree.inventory', 'reprovision requested', { worktree_path: worktreePath })
      const result = await window.ion.gitWorktreeReprovision({ repoPath, worktreePath })
      if (!result.ok) {
        rWarn('worktree.inventory', 'reprovision failed', {
          worktree_path: worktreePath, state: result.state, error: result.error ?? '',
        })
      }
      await get().refreshWorktreeInventory(repoPath)
      return result
    },

    /**
     * Set or clear the operator's workflow stage on a worktree, then refresh
     * so every row shows the new marker.
     *
     * A store action (FORWARDED in the ATV mirror) rather than a component
     * handler: the write must run in the owner window, and the refresh that
     * follows must read owner truth, not stale mirror state.
     */
    setWorktreeStage: async (repoPath, worktreePath, stage) => {
      rInfo('worktree.inventory', 'stage set', { worktree_path: worktreePath, stage: stage ?? 'none' })
      const result = await window.ion.gitWorktreeSetStage({ worktreePath, repoPath, stage })
      if (!result.ok) {
        rWarn('worktree.inventory', 'stage set refused', {
          worktree_path: worktreePath, stage: stage ?? 'none', error: result.error ?? '',
        })
      }
      await get().refreshWorktreeInventory(repoPath)
    },

    /**
     * Deprecated shim over `setWorktreeStage` — see session-store-types.ts for
     * the contract and the removal condition (the four unmigrated sibling
     * branches). The verdict→stage mapping is the shared `legacyReviewToStage`
     * table, the same one the workspaces-file load migration uses, so the two
     * cannot drift. `sourceBranch` is ignored: stages are worktree-scoped.
     */
    benchSetReview: async (repoPath, _sourceBranch, worktreePath, review) => {
      rInfo('worktree.inventory', 'deprecated benchSetReview shim invoked', {
        worktree_path: worktreePath, review: review ?? 'none',
      })
      await get().setWorktreeStage(repoPath, worktreePath, legacyReviewToStage(review) ?? null)
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
        // A failed sync used to fail into the log and nowhere else; the
        // operator believed it succeeded. Record it so the toast and the row
        // badge fire at the moment of failure. Two shapes:
        //  - conflicts: an operation is stuck; the ConflictsDialog resolves it;
        //  - dirty refusals: nothing started; the remediation is the message
        //    (commit or stash) and there is nothing to "resolve".
        if (result.hasConflicts) {
          get().recordConflictAlert(worktreePath, {
            source: 'sync',
            kind: 'conflict',
            operationState: 'rebasing',
            message: result.error,
            label: worktreePath.split('/').filter(Boolean).pop(),
          })
        } else if (result.refusedDirty) {
          get().recordConflictAlert(worktreePath, {
            source: 'sync',
            kind: 'refusal',
            message: result.error,
            label: worktreePath.split('/').filter(Boolean).pop(),
          })
        }
      }
      await get().refreshWorktreeInventory(repoPath)
      return result
    },
  }
}
