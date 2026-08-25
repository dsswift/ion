/**
 * Worktree retire and re-attach — the two moves that change where a
 * conversation's work lives.
 *
 * Both are deliberately split from the CONVERSATION side of the operation.
 * These functions only do the git work and report what they touched; the caller
 * decides what happens to the conversations that were living there. Keeping
 * them separate means the git result and the conversation-side effect are
 * independently observable, and a failed conversation-side step never leaves a
 * half-removed worktree looking like a success.
 *
 * - **Retire**: the work has landed or is being abandoned, and the worktree is
 *   no longer needed. Remove the worktree and its branch, and report the repo
 *   root plus any bench directories the disenrollment pruned. The renderer
 *   CLOSES the conversations that lived in those directories (retire means
 *   there is nothing left to continue), keeping the repo root only as the
 *   relocation fallback for a tab it could not close.
 * - **Re-attach**: the conversation is alive at the repo root (or anywhere)
 *   and needs isolation again — typically a bug found after the merge. Cut a
 *   fresh worktree from the CURRENT source tip and hand back its path, so the
 *   same conversation continues in a clean isolated tree with no re-priming.
 */
import { mkdirSync, readdirSync, rmSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { basename, join } from "path";
import { runGit } from "../git-runner";
import { repositoryManager } from "../git/repositoryManager";
import { log as _log, warn as _warn } from "../logger";
import { registerWorktree, unregisterWorktree } from "./inventory";
import { triggerWorktreeLifecycleAutomation } from "./lifecycle-automation-trigger";
import { disenrollWorktree } from "../integration/bench-ops";
import { writeRecoveryRef } from "./recovery";
import { appraiseWorktree, preserveWorktreeWork } from "./safety";
import { clearProvisionState } from "./provision-state";
import type { WorktreeInfo, WorktreeMoveResult } from "../../shared/types";

const TAG = "worktree.move";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}

export interface RetireOptions {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  /**
   * Remove even when the worktree has uncommitted changes. Default false: an
   * accidental retire must not silently destroy work.
   */
  force?: boolean;
}

export interface DiscardOptions {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  sourceBranch: string;
}

/**
 * Discard a worktree without changing its source branch.
 *
 * The appraisal and recovery both run inside the repository mutation queue. This
 * closes the check-to-remove race: work discovered at execution time is anchored
 * under `refs/ion/discarded/` before the checkout and branch disappear.
 */
export async function discardWorktree(
  opts: DiscardOptions,
): Promise<WorktreeMoveResult> {
  const repo = repositoryManager.get(opts.repoPath);
  return repo.queue.enqueueMutation(async () => {
    log("discard: starting", {
      repo_path: opts.repoPath,
      worktree_path: opts.worktreePath,
      branch: opts.branchName,
      source_branch: opts.sourceBranch,
    });

    const appraisal = await appraiseWorktree(
      opts.worktreePath,
      opts.sourceBranch,
    );
    if (appraisal.appraisalFailed) {
      warn("discard: refused because appraisal failed", {
        worktree_path: opts.worktreePath,
        error: appraisal.reason ?? "",
      });
      return {
        ok: false,
        error:
          appraisal.reason ??
          "Could not determine what this worktree contains.",
      };
    }

    let recoveryRef: string | undefined;
    let preservedRefCount = 0;
    if (!appraisal.safeToDiscard) {
      const preservation = await preserveWorktreeWork(
        opts.repoPath,
        opts.worktreePath,
        opts.branchName,
      );
      if (preservation.error) {
        warn("discard: refused because preservation failed", {
          worktree_path: opts.worktreePath,
          error: preservation.error,
        });
        return {
          ok: false,
          error: `${preservation.error} The worktree was kept so nothing is lost.`,
        };
      }
      recoveryRef = preservation.refs[0];
      preservedRefCount = preservation.refs.length;
    } else {
      log("discard: worktree safe, no recovery ref needed", {
        worktree_path: opts.worktreePath,
      });
    }

    const result = await removeWorktreeUnqueued({
      repoPath: opts.repoPath,
      worktreePath: opts.worktreePath,
      branchName: opts.branchName,
      force: true,
      operation: "discard",
    });
    if (result.ok) {
      result.recoveryRef = recoveryRef;
      log("discard: done without landing", {
        worktree_path: opts.worktreePath,
        preserved_refs: preservedRefCount,
      });
    }
    return result;
  });
}

interface RemoveWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  force: boolean;
  operation: "discard" | "retire";
}

/** Remove a worktree after the caller has completed its safety decision. */
async function removeWorktreeUnqueued(
  opts: RemoveWorktreeOptions,
): Promise<WorktreeMoveResult> {
  const { repoPath, worktreePath, branchName, force, operation } = opts;
  try {
    const removeArgs = ["worktree", "remove", worktreePath];
    if (force) removeArgs.push("--force");
    await runGit(repoPath, removeArgs);
    log("worktree removed", { operation, worktree_path: worktreePath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn("worktree remove failed", {
      operation,
      worktree_path: worktreePath,
      error: msg,
    });
    return { ok: false, error: msg };
  }

  try {
    await runGit(repoPath, ["branch", "-D", branchName]);
    log("worktree branch deleted", { operation, branch: branchName });
  } catch (err) {
    log("worktree branch delete skipped after removal", {
      operation,
      branch: branchName,
      error: String(err),
    });
  }

  clearProvisionState(worktreePath);
  let registryWarning: string | undefined;
  if (!unregisterWorktree(worktreePath)) {
    registryWarning = "Worktree removed but registry persist failed.";
    warn("worktree removed but registry persist failed", {
      operation,
      worktree_path: worktreePath,
    });
  }

  const { removedFrom, prunedBenches } = disenrollWorktree(worktreePath);
  if (removedFrom > 0) {
    log("worktree disenrolled from benches", {
      operation,
      worktree_path: worktreePath,
      benches: removedFrom,
      pruned: prunedBenches.length,
    });
  }
  for (const benchPath of prunedBenches) {
    try {
      await runGit(repoPath, ["worktree", "remove", benchPath, "--force"]);
      log("pruned bench worktree removed", {
        operation,
        bench_path: benchPath,
      });
    } catch (err) {
      log("pruned bench worktree removal skipped", {
        operation,
        bench_path: benchPath,
        error: String(err),
      });
    }
  }

  pruneEmptyParent(worktreePath);
  return {
    ok: true,
    workingDirectory: repoPath,
    prunedBenchPaths: prunedBenches,
    warning: registryWarning,
  };
}

/**
 * Remove a worktree after its work has landed, or force-remove dirty state only
 * after writing a recovery snapshot. This legacy path remains for landed cleanup.
 */
export async function retireWorktree(
  opts: RetireOptions,
): Promise<WorktreeMoveResult> {
  const repo = repositoryManager.get(opts.repoPath);
  return repo.queue.enqueueMutation(() => retireWorktreeUnqueued(opts));
}

/**
 * The retire body without its queue wrapper. Callers must already hold the
 * repository mutation slot. This lets a terminal land-and-retire operation use
 * one slot for both halves without waiting on itself.
 */
export async function retireWorktreeUnqueued(
  opts: RetireOptions,
): Promise<WorktreeMoveResult> {
  const { repoPath, worktreePath, branchName, force } = opts;
  log("retire: starting", {
    repo_path: repoPath,
    worktree_path: worktreePath,
    branch: branchName,
    force: !!force,
  });

  let recoveryRef: string | undefined;
  if (!force) {
    try {
      const status = await runGit(worktreePath, ["status", "--porcelain"]);
      if (status.trim().length > 0) {
        warn("retire: refused, worktree has uncommitted changes", {
          worktree_path: worktreePath,
        });
        return {
          ok: false,
          error:
            "This worktree has uncommitted changes. Commit or discard them before retiring it.",
        };
      }
      log("retire: worktree clean, no snapshot needed", {
        worktree_path: worktreePath,
      });
    } catch (err) {
      // The worktree directory may already be gone (removed outside Ion).
      // That is not a reason to refuse — proceed to the removal, which
      // handles the already-absent case via `git worktree remove`/prune.
      log("retire: status probe failed, continuing to removal", {
        worktree_path: worktreePath,
        error: String(err),
      });
    }
  } else {
    // Forced: the operator confirmed against an appraisal that said work
    // would be lost, and the dialog promised a recovery ref. Write it before
    // anything is destroyed.
    const recovery = await writeRecoveryRef({
      repoPath,
      worktreePath,
      branchName,
    });
    if (recovery.error) {
      warn("retire: refused, could not write recovery ref", {
        worktree_path: worktreePath,
        branch: branchName,
        error: recovery.error,
      });
      return {
        ok: false,
        error: `${recovery.error} The worktree was kept so nothing is lost.`,
      };
    }
    if (recovery.snapshot) {
      recoveryRef = recovery.snapshot.ref;
      log("retire: uncommitted work preserved", {
        worktree_path: worktreePath,
        ref: recovery.snapshot.ref,
        sha: recovery.snapshot.sha,
        files: recovery.snapshot.paths.length,
      });
    } else {
      log("retire: forced but worktree clean, no snapshot written", {
        worktree_path: worktreePath,
      });
    }
  }

  const removal = await removeWorktreeUnqueued({
    repoPath,
    worktreePath,
    branchName,
    force: !!force,
    operation: "retire",
  });
  if (!removal.ok) return removal;

  log("retire: done", {
    worktree_path: worktreePath,
    relocate_to: repoPath,
    recovery_ref: recoveryRef ?? "",
    pruned_benches: removal.prunedBenchPaths?.length ?? 0,
  });
  if (!removal.warning) {
    await triggerWorktreeLifecycleAutomation("worktree:retired", {
      repoPath,
      worktreePath,
      branchName,
      recoveryRef: recoveryRef ?? "",
      prunedBenchPaths: removal.prunedBenchPaths ?? [],
    });
  }
  return { ...removal, recoveryRef };
}

export interface ReattachOptions {
  repoPath: string;
  /** Branch to cut the new worktree from; its CURRENT tip is used. */
  sourceBranch: string;
  /**
   * Name of the conversation being re-attached, carried onto the new worktree.
   *
   * Re-attach always serves a LIVE conversation — one that has been running at
   * the repo root and now needs isolation again — so it virtually always has a
   * name already. Omitting it would leave the row on a hex slug and make the
   * "indistinguishable from an originally-created one" promise below false,
   * since the create path seeds its name too.
   */
  title?: string;
}

/**
 * Create a fresh worktree from the current tip of `sourceBranch`, returning
 * its path so the caller can relocate an existing conversation into it.
 *
 * Mirrors the naming and layout of the original worktree-add path
 * (`~/.ion/worktrees/<repo>-<id>` on a `wt/<hex>` branch) so a re-attached
 * worktree is indistinguishable from an originally-created one to every other
 * part of the system — including the title it carries.
 */
export async function reattachWorktree(
  opts: ReattachOptions,
): Promise<WorktreeMoveResult> {
  const { repoPath, sourceBranch, title } = opts;
  const repo = repositoryManager.get(repoPath);
  return repo.queue.enqueueMutation(async () => {
    log("reattach: starting", {
      repo_path: repoPath,
      source_branch: sourceBranch,
    });
    try {
      const id = randomBytes(4).toString("hex");
      const branchName = `wt/${randomBytes(4).toString("hex")}`;
      const worktreeDir = join(homedir(), ".ion", "worktrees");
      const worktreePath = join(worktreeDir, `${basename(repoPath)}-${id}`);
      mkdirSync(worktreeDir, { recursive: true });
      await runGit(repoPath, [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        sourceBranch,
      ]);
      const worktree: WorktreeInfo = {
        worktreePath,
        branchName,
        sourceBranch,
        repoPath,
      };
      // A re-attached worktree must be indistinguishable from an originally
      // created one, so it registers its source branch the same way — and
      // carries the conversation's name the same way. The base (fresh HEAD ==
      // the source tip just checked out) rides along for the sync verb's
      // precise rebase; failing to read it degrades to the plain fallback.
      let baseSha: string | undefined;
      try {
        baseSha = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
      } catch (err) {
        warn("reattach: could not resolve base sha", {
          worktree_path: worktreePath,
          error: String(err),
        });
      }
      let registryWarning: string | undefined;
      if (
        !registerWorktree({
          worktreePath,
          repoPath,
          branchName,
          sourceBranch,
          title,
          baseSha,
        })
      ) {
        registryWarning = "Worktree created but registry persist failed.";
        warn("reattach: worktree created but registry persist failed", {
          worktree_path: worktreePath,
        });
      }
      log("reattach: created", {
        worktree_path: worktreePath,
        branch: branchName,
        source_branch: sourceBranch,
        title: title ?? "",
      });
      if (!registryWarning) {
        await triggerWorktreeLifecycleAutomation("worktree:created", {
          repoPath,
          worktreePath,
          branchName,
          sourceBranch,
          baseSha: baseSha ?? "",
          source: "reattach",
        });
      }
      return {
        ok: true,
        workingDirectory: worktreePath,
        worktree,
        warning: registryWarning,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn("reattach: failed", {
        repo_path: repoPath,
        source_branch: sourceBranch,
        error: msg,
      });
      return { ok: false, error: msg };
    }
  });
}

/**
 * Remove the worktree parent directory when the last worktree in it is gone.
 * Best-effort housekeeping; a leftover empty directory is harmless.
 */
function pruneEmptyParent(worktreePath: string): void {
  try {
    const parent = join(worktreePath, "..");
    if (readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true });
      log("retire: pruned empty worktree parent", { parent });
    }
  } catch (err) {
    log("retire: parent prune skipped", {
      worktree_path: worktreePath,
      error: String(err),
    });
  }
}
