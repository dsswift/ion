/**
 * Worktree inventory + lifecycle store slice — the shared model behind every
 * worktree surface.
 *
 * One slice feeds all of them (git-panel Worktrees section, the new-tab picker
 * group, the Studio window mount, and the iOS projection), so there is no second
 * implementation to drift. Per AGENTS.md § Studio shell rules, the multi-step
 * flows live here as single store actions rather than in component handlers:
 * a handler runs in whichever window hosts it, and in the Studio mirror that mixes
 * forwarded and local calls while reading stale mirror state.
 */
import type { StoreSet, StoreGet, State } from "../session-store-types";
import { rInfo, rWarn } from "../../rendererLogger";
import {
  closeOccupants,
  resolveRetireBlockers,
} from "./worktree-occupant-close";
import { legacyReviewToStage } from "../../../shared/types-git";
import {
  collectAllDirConversations,
  pickNextConversation,
} from "../../../shared/worktree-conversations";
import { resolveRegisteredWorktree } from "../worktree-registration";
import { createWorktreeRefreshActions } from "./worktree-inventory-refresh";
import { inboxActivityOrder } from "../../studio/inbox/inbox-collapse";
import { usePreferencesStore } from '../../preferences'
import { landFlagsForStrategy } from '../../../shared/worktree-land-strategy'

export function createWorktreeInventorySlice(
  set: StoreSet,
  get: StoreGet,
): Partial<State> {
  return {
    ...createWorktreeRefreshActions(set, get),

    /** Change a worktree title without changing the titles of its conversations. */
    renameWorktree: async (repoPath, worktreePath, title) => {
      const trimmed = title.trim();
      if (!trimmed) return { ok: false, error: "A worktree title is required." };
      const result = await window.ion.gitWorktreeSetTitle({
        repoPath,
        worktreePath,
        title: trimmed,
      });
      if (!result.ok) {
        rWarn("worktree.inventory", "worktree rename failed", {
          worktree_path: worktreePath,
          error: result.error ?? "",
        });
      }
      await get().refreshWorkspaceViews(repoPath);
      return { ok: result.ok, error: result.error };
    },

    /**
     * Create an ADDITIONAL conversation in a worktree, always a new one.
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
      const worktree = await resolveRegisteredWorktree(worktreePath);
      if (worktree?.landedAt) {
        rWarn(
          "worktree.inventory",
          "new conversation refused: worktree has landed",
          {
            worktree_path: worktreePath,
          },
        );
        throw new Error(
          "This worktree has already landed and is sealed for review. Retire it when review is complete.",
        );
      }
      rInfo("worktree.inventory", "opening new conversation in worktree", {
        worktree_path: worktreePath,
      });
      // createTabInDirectory with useWorktree=false: the worktree already
      // exists, so this must NOT create another one inside it.
      // skipDuplicateCheck=true: an additional conversation here is the request.
      const tabId = await get().createTabInDirectory(worktreePath, false, true);

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
      if (worktree) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, worktree } : t)),
        }));
      } else {
        // Without a known source branch the lifecycle verbs are unanswerable.
        // Leave `worktree` unset rather than inventing a source branch: the tab
        // still works as a directory conversation, and the UI asks.
        rWarn(
          "worktree.inventory",
          "opened worktree conversation without known source branch",
          {
            worktree_path: worktreePath,
          },
        );
      }
      return tabId;
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
     * it — so there is no cursor for the overlay and the Studio mirror to disagree
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
      const matches = collectAllDirConversations(
        inboxActivityOrder(get().tabs),
        worktreePath,
      );
      const next = pickNextConversation(matches, get().activeTabId);
      if (next) {
        rInfo(
          "worktree.inventory",
          "focusing existing conversation for worktree",
          {
            worktree_path: worktreePath,
            match_count: matches.length,
            from_tab: (get().activeTabId ?? "none").slice(0, 8),
            to_tab: next.tabId.slice(0, 8),
          },
        );
        get().selectTab(next.tabId);
        return next.tabId;
      }

      return get().newWorktreeConversation(worktreePath);
    },

    /**
     * Terminal worktree completion. Preflight the directories that removal can
     * affect, merge and remove under one main-process queue slot, then close the
     * finished conversations whose checkout no longer exists.
     */
    landAndRetireWorktree: async (repoPath, entry, strategyOverride) => {
      let benchPaths: string[] = []
      try {
        benchPaths = (await window.ion.gitWorktreeRetirePreview(entry.worktreePath)).prunedBenchPaths ?? []
      } catch (error) {
        rWarn('worktree.inventory', 'terminal completion preview failed', {
          worktree_path: entry.worktreePath,
          error: String(error),
        })
      }
      const blockers = resolveRetireBlockers(get, entry.worktreePath, benchPaths)
      if (blockers) return { ok: false, error: blockers.error }

      const strategy = strategyOverride ?? usePreferencesStore.getState().worktreeCompletionStrategy
      const flags = landFlagsForStrategy(strategy)
      const result = await window.ion.gitWorktreeLandAndRetire({
        repoPath,
        worktreePath: entry.worktreePath,
        worktreeBranch: entry.branchName,
        branchName: entry.branchName,
        sourceBranch: entry.sourceBranch,
        noFf: flags.noFf,
        syncFirst: flags.syncFirst,
        requireFastForward: flags.requireFastForward,
      })
      if (!result.ok) {
        rWarn('worktree.inventory', 'land and retire refused', {
          worktree_path: entry.worktreePath,
          landed: !!result.landed,
          has_conflicts: !!result.hasConflicts,
          error: result.error ?? '',
        })
        if (result.hasConflicts && result.conflictDirectory) {
          get().recordConflictAlert(result.conflictDirectory, {
            source: 'land',
            operationState: result.conflictDirectory === entry.worktreePath ? 'rebasing' : 'merging',
            label: result.conflictDirectory === entry.worktreePath ? entry.title || entry.label : result.conflictDirectory.split('/').filter(Boolean).pop(),
          })
        }
        await get().refreshWorkspaceViews(repoPath)
        return result
      }
      await closeOccupants(
        set,
        get,
        [entry.worktreePath, ...(result.prunedBenchPaths ?? [])],
        result.workingDirectory,
      )
      await get().refreshWorkspaceViews(repoPath)
      rInfo('worktree.inventory', 'land and retire complete', {
        worktree_path: entry.worktreePath,
        pruned_benches: result.prunedBenchPaths?.length ?? 0,
      })
      return result
    },

    /**
     * Internal legacy cleanup for records that were landed before terminal
     * completion: remove the worktree and close every conversation that lived
     * there.
     *
     * ── Why this is a store action, not a component handler ─────────────────
     * It reads store state between mutations (which tabs occupy this worktree,
     * are any of them busy, then close them). Per AGENTS.md § Studio shell rules a
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
      let benchPaths: string[] = [];
      try {
        const preview = await window.ion.gitWorktreeRetirePreview(worktreePath);
        benchPaths = preview.prunedBenchPaths ?? [];
      } catch (err) {
        // Fail SAFE on the pre-flight's scope, not open: with no prediction the
        // worktree's own occupants are still checked and closed. A bench tab
        // could be missed, so this is logged at WARN rather than swallowed.
        rWarn(
          "worktree.inventory",
          "retire preview failed; checking the worktree only",
          {
            worktree_path: worktreePath,
            error: String(err),
          },
        );
      }

      const blockers = resolveRetireBlockers(get, worktreePath, benchPaths);
      if (blockers) {
        // Nothing on disk has been touched. Refresh so the row reflects current
        // state, and hand the named refusal back for the caller to render.
        await get().refreshWorktreeInventory(repoPath);
        return { ok: false, error: blockers.error };
      }

      rInfo("worktree.inventory", "retire requested", {
        worktree_path: worktreePath,
        branch: branchName,
        bench_paths: benchPaths.length,
      });

      const result = await window.ion.gitWorktreeLandAndRetire({
        repoPath,
        worktreePath,
        worktreeBranch: branchName,
        branchName,
        // A legacy landed record selects backend cleanup-only mode, so this is
        // never used to integrate the branch again.
        sourceBranch: (get().worktreeInventory.get(repoPath) ?? []).find((entry) => entry.worktreePath === worktreePath)?.sourceBranch ?? '',
      });

      if (!result.ok) {
        rWarn("worktree.inventory", "retire refused; nothing closed", {
          worktree_path: worktreePath,
          error: result.error ?? "",
        });
        await get().refreshWorktreeInventory(repoPath);
        return result;
      }

      // The directories are gone. Close their conversations, keeping the repo
      // root only as the fallback for a tab that became busy in the window
      // between the pre-flight and the removal.
      await closeOccupants(
        set,
        get,
        [worktreePath, ...(result.prunedBenchPaths ?? [])],
        result.workingDirectory,
      );

      await get().refreshWorktreeInventory(repoPath);
      return result;
    },

    retireLandedWorktrees: async (repoPath) => {
      const landed = (get().worktreeInventory.get(repoPath) ?? []).filter(
        (entry) => !!entry.landedAt,
      );
      if (landed.length === 0) return { ok: true, retired: 0 };

      // Preflight every directory before removing any one. A partial bulk retire
      // would leave a misleading "all" outcome and is never safer than refusing
      // before disk state changes.
      for (const entry of landed) {
        const blockers = resolveRetireBlockers(get, entry.worktreePath, []);
        if (blockers) return { ok: false, retired: 0, error: blockers.error };
      }

      let retired = 0;
      for (const entry of landed) {
        const result = await get().retireWorktree(
          repoPath,
          entry.worktreePath,
          entry.branchName,
        );
        if (!result.ok) {
          return {
            ok: false,
            retired,
            error: result.error ?? "Could not retire a landed worktree.",
          };
        }
        retired++;
      }
      rInfo("worktree.inventory", "retired landed worktrees", {
        repo_path: repoPath,
        retired,
      });
      return { ok: true, retired };
    },

    /**
     * Re-run provisioning for a worktree, then refresh so the row reflects the
     * new state.
     *
     * A store action rather than a component handler because it mutates
     * owner-side state and then reads it back through the inventory — the
     * pattern the Studio mirror rules require (a handler would run locally in the
     * mirror and decide against stale state).
     */
    reprovisionWorktree: async (repoPath, worktreePath) => {
      rInfo("worktree.inventory", "reprovision requested", {
        worktree_path: worktreePath,
      });
      const result = await window.ion.gitWorktreeReprovision({
        repoPath,
        worktreePath,
      });
      if (!result.ok) {
        rWarn("worktree.inventory", "reprovision failed", {
          worktree_path: worktreePath,
          state: result.state,
          error: result.error ?? "",
        });
      }
      await get().refreshWorktreeInventory(repoPath);
      return result;
    },

    /**
     * Set or clear the operator's workflow stage on a worktree, then refresh
     * so every row shows the new marker.
     *
     * A store action (FORWARDED in the Studio mirror) rather than a component
     * handler: the write must run in the owner window, and the refresh that
     * follows must read owner truth, not stale mirror state.
     */
    setWorktreeStage: async (repoPath, worktreePath, stage) => {
      rInfo("worktree.inventory", "stage set", {
        worktree_path: worktreePath,
        stage: stage ?? "none",
      });
      const result = await window.ion.gitWorktreeSetStage({
        worktreePath,
        repoPath,
        stage,
      });
      if (!result.ok) {
        rWarn("worktree.inventory", "stage set refused", {
          worktree_path: worktreePath,
          stage: stage ?? "none",
          error: result.error ?? "",
        });
      }
      await get().refreshWorktreeInventory(repoPath);
    },

    /**
     * Deprecated shim over `setWorktreeStage` — see session-store-types.ts for
     * the contract and the removal condition (the four unmigrated sibling
     * branches). The verdict→stage mapping is the shared `legacyReviewToStage`
     * table, the same one the workspaces-file load migration uses, so the two
     * cannot drift. `sourceBranch` is ignored: stages are worktree-scoped.
     */
    benchSetReview: async (repoPath, _sourceBranch, worktreePath, review) => {
      rInfo("worktree.inventory", "deprecated benchSetReview shim invoked", {
        worktree_path: worktreePath,
        review: review ?? "none",
      });
      await get().setWorktreeStage(
        repoPath,
        worktreePath,
        legacyReviewToStage(review) ?? null,
      );
    },

    /**
     * Sync a worktree onto its source branch (resolves BASE staleness), then
     * refresh the inventory so the badge clears.
     */
    syncWorktree: async (worktreePath, sourceBranch, repoPath) => {
      rInfo("worktree.inventory", "sync requested", {
        worktree_path: worktreePath,
        source_branch: sourceBranch,
      });
      const result = await window.ion.gitWorktreeSync(
        worktreePath,
        sourceBranch,
      );
      if (!result.ok) {
        rWarn("worktree.inventory", "sync failed", {
          worktree_path: worktreePath,
          refused_dirty: !!result.refusedDirty,
          has_conflicts: !!result.hasConflicts,
          error: result.error ?? "",
        });
        // A conflict leaves an in-progress operation. Record it immediately
        // so Git panel banner can open ConflictsDialog before inventory refresh.
        // Dirty refusals start no operation; disabled row tooltip already gives
        // remediation, while this logged failure remains observable.
        if (result.hasConflicts) {
          get().recordConflictAlert(worktreePath, {
            source: "sync",
            operationState: "rebasing",
            label: worktreePath.split("/").filter(Boolean).pop(),
          });
        }
      }
      await get().refreshWorktreeInventory(repoPath);
      return result;
    },
  };
}
