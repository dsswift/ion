/**
 * Worktree inventory refresh + landed-worktree seal.
 *
 * Split out of `worktree-inventory-slice.ts` at the file-size cap, on the seam
 * that already existed: these three actions are the READ path — re-reading git
 * into the store's caches and reconciling the conversations that live in a
 * landed checkout. Everything left in the slice is a lifecycle VERB that
 * mutates a worktree (new, open, land, retire, reprovision, sync).
 *
 * The seam matters beyond line count. This path is driven by render-time
 * effects, not by an operator action, so it carries a quiescence obligation the
 * verbs do not: called repeatedly against unchanged git state it must produce
 * no store write and no engine traffic. That property is pinned by
 * `__tests__/worktree-inventory-seal.test.ts`.
 */
import type { StoreSet, StoreGet, State } from "../session-store-types";
import { rInfo, rWarn, rDebug } from "../../rendererLogger";
import { isWithinRepo } from "../../../shared/repo-containment";
import { deepEqual } from "../../../shared/deep-equal";

export function createWorktreeRefreshActions(
  set: StoreSet,
  get: StoreGet,
): Partial<State> {
  return {
    /**
     * Refresh the worktree list for a repo.
     *
     * Keyed by repo path so several projects can be open at once without their
     * inventories overwriting each other.
     */
    refreshWorktreeInventory: async (repoPath) => {
      if (!repoPath || repoPath === "~") return;
      try {
        const { worktrees } = await window.ion.gitWorktreeInventory(repoPath);
        // Write only on change. An unconditional `new Map(...)` notifies every
        // subscriber on every pass, which is what let a render-driven effect
        // (the Studio Inbox refreshing the projects it displays) feed itself:
        // refresh → store notify → re-render → refresh. The comparison makes a
        // quiescent refresh a genuine no-op so that cycle terminates.
        const cached = get().worktreeInventory.get(repoPath);
        if (cached && deepEqual(cached, worktrees)) {
          rDebug("worktree.inventory", "refresh found no change", {
            repo_path: repoPath,
            count: worktrees.length,
          });
        } else {
          set((s) => ({
            worktreeInventory: new Map(s.worktreeInventory).set(
              repoPath,
              worktrees,
            ),
          }));
        }
        // Conflict state rides same refresh. An in-progress operation can have
        // started outside Ion or before restart, and must reach Git panel before
        // user opens a row. State clears when operation ends.
        const inventoryPaths = new Set(worktrees.map((wt) => wt.worktreePath));
        for (const wt of worktrees) {
          if (wt.landedAt) {
            void get()
              .sealLandedWorktree(wt.worktreePath)
              .catch((err) =>
                rWarn(
                  "worktree.inventory",
                  "could not seal landed worktree conversations",
                  { worktree_path: wt.worktreePath, error: String(err) },
                ),
              );
            continue;
          }
          if (wt.operationState) {
            get().recordConflictAlert(wt.worktreePath, {
              source: "detected",
              operationState: wt.operationState,
              label: wt.label,
            });
          } else {
            get().clearConflictAlert(wt.worktreePath);
          }
        }
        // A land conflict can stop in repo root, which is not an inventory row.
        // Re-probe those alert directories or banner would survive resolution.
        for (const [directory, alert] of get().gitConflictAlerts) {
          if (
            inventoryPaths.has(directory) ||
            !isWithinRepo(directory, repoPath)
          )
            continue;
          try {
            const operation = await window.ion.gitOpState(directory);
            if (!operation.ok) {
              rWarn(
                "worktree.inventory",
                "could not refresh non-worktree conflict state",
                {
                  repo_path: repoPath,
                  directory,
                  error: operation.error ?? "",
                },
              );
            } else if (operation.state) {
              get().recordConflictAlert(directory, {
                source: "detected",
                operationState: operation.state,
                label: alert.label,
              });
            } else {
              get().clearConflictAlert(directory);
            }
          } catch (err) {
            rWarn(
              "worktree.inventory",
              "non-worktree conflict state probe threw",
              {
                repo_path: repoPath,
                directory,
                error: String(err),
              },
            );
          }
        }
        rDebug("worktree.inventory", "refreshed", {
          repo_path: repoPath,
          count: worktrees.length,
        });
      } catch (err) {
        rWarn("worktree.inventory", "refresh failed", {
          repo_path: repoPath,
          error: String(err),
        });
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
     * is mirror-local by classification (see studio-mirror-actions.ts).
     */
    refreshWorkspaceViews: async (repoPath) => {
      if (!repoPath || repoPath === "~") {
        rDebug(
          "worktree.inventory",
          "workspace refresh skipped: no repo path",
          { repo_path: repoPath },
        );
        return;
      }
      const [inventory, bench] = await Promise.allSettled([
        get().refreshWorktreeInventory(repoPath),
        get().refreshBench(repoPath),
      ]);
      rDebug("worktree.inventory", "workspace views refreshed", {
        repo_path: repoPath,
        inventory: inventory.status,
        bench: bench.status,
      });
    },

    /**
     * Seal every conversation living in a landed worktree.
     *
     * Idempotent by construction, because the caller is not a one-shot verb:
     * every inventory refresh re-walks the landed rows and re-invokes this for
     * each one. A version that re-sealed unconditionally re-`set()` the tabs
     * (new identities → a store notification → another refresh) and re-issued
     * `engineStop` for a session that was already stopped, at whatever rate the
     * refresh ran. Tabs already carrying the `landed-worktree` lock are
     * therefore filtered out before any mutation, and an empty remainder
     * returns without touching the store.
     */
    sealLandedWorktree: async (worktreePath) => {
      const tabs = get().tabs.filter(
        (tab) =>
          tab.workingDirectory === worktreePath &&
          !(tab.inputLocked && tab.inputLockReason === "landed-worktree"),
      );
      if (tabs.length === 0) return;
      // Keyed by id, not by working directory: re-mapping an already-sealed tab
      // would hand it a fresh object identity for an unchanged value, which is
      // the same subscriber-notification defect one level down.
      const unsealed = new Set(tabs.map((tab) => tab.id));
      set((s) => ({
        tabs: s.tabs.map((tab) =>
          unsealed.has(tab.id) && !tab.isTerminalOnly
            ? {
                ...tab,
                inputLocked: true,
                inputLockReason: "landed-worktree" as const,
                worktree: tab.worktree
                  ? {
                      ...tab.worktree,
                      landedAt: tab.worktree.landedAt ?? Date.now(),
                    }
                  : null,
              }
            : tab,
        ),
      }));
      for (const tab of tabs) {
        if (tab.isTerminalOnly) {
          get().closeTab(tab.id);
          continue;
        }
        try {
          await window.ion.engineStop(tab.id);
          rInfo("worktree.inventory", "sealed landed review session", {
            worktree_path: worktreePath,
            tab_id: tab.id.slice(0, 8),
          });
        } catch (err) {
          rWarn("worktree.inventory", "could not stop sealed review session", {
            worktree_path: worktreePath,
            tab_id: tab.id.slice(0, 8),
            error: String(err),
          });
        }
      }
    },
  };
}
