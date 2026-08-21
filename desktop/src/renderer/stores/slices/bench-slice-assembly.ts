/**
 * Integration workspace (bench) store slice — assembly and member management.
 *
 * Split from bench-slice.ts (file-size cap): that file owns bench
 * *navigation* (open/cycle a bench conversation, open the bench terminal);
 * this file owns bench *mutation* (assemble, resolve a failed assembly,
 * rerere recording management, member add/remove/enable/reorder, and the
 * absorbed-into-base notice). Both are thin forwarders to the main process,
 * which owns the workspace record, for the same reason: the renderer holds a
 * read model only, so overlay, Studio mirror, and iOS cannot drift.
 */
import type { StoreSet, StoreGet, State } from "../session-store-types";
import type { BenchAssembleResult } from "../../../shared/types";
import { rInfo, rWarn, rDebug } from "../../rendererLogger";

export function createBenchAssemblySlice(
  set: StoreSet,
  get: StoreGet,
): Partial<State> {
  return {
    benchAssemble: async (repoPath, sourceBranch) => {
      rInfo("bench", "assemble requested", { source_branch: sourceBranch });
      const result = await window.ion.benchAssemble(repoPath, sourceBranch);
      if (!result.ok) {
        // A typed refusal is the machinery protecting an in-flight state (an
        // open resolution merge, a dirty bench) — expected, not a failure.
        if (result.refusal)
          rInfo("bench", "assemble refused", {
            refusal: result.refusal,
            detail: result.error ?? "",
          });
        else rWarn("bench", "assemble failed", { error: result.error ?? "" });
      } else if (result.workspace?.lastAssembly === "failed") {
        rWarn("bench", "assembly failed atomically", {
          error: result.workspace.lastAssemblyError ?? "",
        });
      }
      recordRetired(set, repoPath, sourceBranch, result);
      await get().refreshBench(repoPath);
      return result;
    },

    /**
     * Resolve-once flow (Studio multi-step rule: ONE forwarded action). The main
     * process re-creates the failed assembly merge and leaves it in progress;
     * the returned bench path is where the caller opens the ConflictsDialog.
     * When recordings already cover every hunk, nothing is left to resolve —
     * reassemble instead and return null so no dialog opens over a clean bench.
     */
    benchResolveConflict: async (repoPath, sourceBranch) => {
      rInfo("bench", "resolve conflict requested", {
        source_branch: sourceBranch,
      });
      const prepared = await window.ion.benchResolveConflict(
        repoPath,
        sourceBranch,
      );
      if (!prepared.ok) {
        rWarn("bench", "resolve preparation failed", {
          error: prepared.error ?? "",
        });
        return null;
      }
      if (!prepared.branchName) {
        // No merge was left open: recordings (or a pin change) already cover
        // the conflict, so a plain assembly completes the job.
        rInfo("bench", "no conflict remains, reassembling", {
          source_branch: sourceBranch,
        });
        await get().benchAssemble(repoPath, sourceBranch);
        return null;
      }
      rInfo("bench", "merge left in progress for resolution", {
        bench_path: prepared.benchPath ?? "",
        branch: prepared.branchName,
      });
      return prepared.benchPath ?? null;
    },

    benchRerereCount: async (directory) => {
      const result = await window.ion.benchRerereCount(directory);
      if (!result.ok)
        throw new Error(result.error ?? "Could not count conflict recordings");
      return result.count;
    },

    benchRerereForget: async (directory, paths) => {
      const result = await window.ion.benchRerereForget(directory, paths);
      if (!result.ok)
        throw new Error(result.error ?? "Could not forget conflict recordings");
      rInfo("bench", "forgot selected conflict recordings", {
        directory,
        count: result.count,
      });
      return result.count;
    },

    benchRerereDiscardAll: async (directory) => {
      const result = await window.ion.benchRerereDiscardAll(directory);
      if (!result.ok)
        throw new Error(
          result.error ?? "Could not discard conflict recordings",
        );
      rInfo("bench", "discarded all conflict recordings", {
        directory,
        count: result.count,
      });
      return result.count;
    },

    /**
     * Forget only recordings associated with selected member branches, then
     * reassemble unchanged pins. This is one forwarded action so the Studio never
     * decides against its mirror snapshot while a shared Git mutation runs.
     */
    benchDiscardMemberRecordings: async (
      repoPath,
      sourceBranch,
      branchNames,
    ) => {
      rInfo("bench", "discard member recordings requested", {
        repo_path: repoPath,
        source_branch: sourceBranch,
        branches: branchNames,
      });
      const result = await window.ion.benchDiscardMemberRecordings(
        repoPath,
        sourceBranch,
        branchNames,
      );
      if (!result.ok) {
        rWarn("bench", "discard member recordings failed", {
          repo_path: repoPath,
          source_branch: sourceBranch,
          error: result.error ?? "",
        });
      } else {
        rInfo("bench", "discard member recordings completed", {
          repo_path: repoPath,
          source_branch: sourceBranch,
          branches: branchNames,
          forgotten_count: result.forgottenCount ?? 0,
          nothing_to_forget: result.branchesWithNothingToForget ?? [],
          outcome: result.workspace?.lastAssembly ?? "unknown",
        });
      }
      await get().refreshBench(repoPath);
      return result;
    },

    benchUpdateMember: async (repoPath, sourceBranch, worktreePath) => {
      rInfo("bench", "update member", { worktree_path: worktreePath });
      const result = await window.ion.benchUpdateMember({
        repoPath,
        sourceBranch,
        worktreePath,
      });
      if (!result.ok)
        rWarn("bench", "update member failed", { error: result.error ?? "" });
      if (result.warning)
        rWarn("bench", "update predicts a collision", {
          warning: result.warning,
        });
      recordRetired(set, repoPath, sourceBranch, result);
      await get().refreshBench(repoPath);
      return result;
    },

    benchUpdateAll: async (repoPath, sourceBranch) => {
      rInfo("bench", "update all stale", { source_branch: sourceBranch });
      const result = await window.ion.benchUpdateAll(repoPath, sourceBranch);
      if (!result.ok)
        rWarn("bench", "update all failed", { error: result.error ?? "" });
      if (result.warning)
        rWarn("bench", "update-all predicts a collision", {
          warning: result.warning,
        });
      recordRetired(set, repoPath, sourceBranch, result);
      await get().refreshBench(repoPath);
      return result;
    },

    benchApplyOverlapFastLane: async (
      repoPath,
      sourceBranch,
      basis,
      orderedPaths,
    ) => {
      // One owner-side action: applying a recommendation is a single durable
      // member-set replacement, never a mirror-side loop of enable/reorder calls.
      const result = await window.ion.applyWorktreeOverlap(basis, orderedPaths);
      if (!result.ok)
        rWarn("bench", "overlap fast lane refused", {
          repo_path: repoPath,
          source_branch: sourceBranch,
          error: result.error ?? "",
        });
      await get().refreshWorkspaceViews(repoPath);
      return result;
    },

    benchAddMember: async (
      repoPath,
      sourceBranch,
      worktreePath,
      branchName,
    ) => {
      const result = await window.ion.benchAddMember({
        repoPath,
        sourceBranch,
        worktreePath,
        branchName,
      });
      if (!result.ok)
        rWarn("bench", "add member refused", {
          branch: branchName,
          error: result.error ?? "",
        });
      await get().refreshBench(repoPath);
      return result;
    },

    benchRemoveMember: async (repoPath, sourceBranch, worktreePath) => {
      rInfo("bench", "remove member", { worktree_path: worktreePath });
      await window.ion.benchRemoveMember({
        repoPath,
        sourceBranch,
        worktreePath,
      });
      await get().refreshBench(repoPath);
    },

    benchSetOrder: async (repoPath, sourceBranch, worktreePath, toIndex) => {
      rInfo("bench", "member order set", {
        worktree_path: worktreePath,
        to_index: toIndex,
      });
      await window.ion.benchSetOrder({
        repoPath,
        sourceBranch,
        worktreePath,
        toIndex,
      });
      await get().refreshBench(repoPath);
    },

    clearBenchRetired: (repoPath, sourceBranch) => {
      rDebug("bench", "absorbed notice dismissed", {
        repo_path: repoPath,
        source_branch: sourceBranch,
      });
      set((s) => {
        const forRepo = s.benchRetired.get(repoPath);
        if (!forRepo || !forRepo.has(sourceBranch)) return {};
        const nextForRepo = new Map(forRepo);
        nextForRepo.delete(sourceBranch);
        return {
          benchRetired: new Map(s.benchRetired).set(repoPath, nextForRepo),
        };
      });
    },
  };
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
  const absorbed = result.retired ?? [];
  if (absorbed.length > 0) {
    rInfo("bench", "members absorbed into base", {
      repo_path: repoPath,
      source_branch: sourceBranch,
      count: absorbed.length,
      branches: absorbed.map((m) => m.branchName).join(","),
    });
  }
  set((s) => {
    const forRepo = new Map(s.benchRetired.get(repoPath) ?? []);
    if (absorbed.length > 0) forRepo.set(sourceBranch, absorbed);
    else forRepo.delete(sourceBranch);
    return { benchRetired: new Map(s.benchRetired).set(repoPath, forRepo) };
  });
}
