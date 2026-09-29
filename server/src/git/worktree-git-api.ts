/**
 * worktree-git-api — the four worktree verbs that sit behind the SAME
 * `gitDirect` capability as the Git panel, headless.
 *
 * They are here rather than with the rest of the worktree lifecycle because
 * the capability flag is what decides whether a client may call them, and a
 * flag can only be honestly true when every verb it gates is reachable.
 * Leaving these four in `desktop/src/main/ipc/worktree*.ts` while bridging
 * the other 41 git verbs would have made `gitDirect` a half-truth: the panel
 * would work and these four menu items would throw.
 *
 * Bodies are relocated verbatim, minus the unused Electron event parameter.
 */
import { runGit } from './git-runner'
import { syncWorktreeFromSource } from '../worktree/integrate'
import { appraiseWorktree } from '../worktree/safety'
import { predictPrunedBenches } from '../integration/bench-ops'
import { lookupWorktreeRegistration, setWorktreeTitle } from '../worktree/inventory'
import { announceWorktreeTitle } from '../worktree/title-announce'
import { isValidProjectPath } from '../ipc-validation'
import { IPC } from '@ion/shared/types'
import { log as _log, warn as _warn } from '../logger'

const log = (msg: string, fields?: Record<string, unknown>): void => { _log('worktree-git-api', msg, fields) }
const warn = (msg: string, fields?: Record<string, unknown>): void => { _warn('worktree-git-api', msg, fields) }

/** Channel-keyed worktree-git handlers. Merged into `GIT_HANDLERS` by `git-api.ts`. */
export const WORKTREE_GIT_HANDLERS: Record<string, (payload: any) => Promise<unknown> | unknown> = {
  [IPC.GIT_WORKTREE_REBASE]: async ({
        worktreePath,
        sourceBranch,
      }: { worktreePath: string; sourceBranch: string },
    ) => {
      try {
        await runGit(worktreePath, ["fetch", "origin"]);
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
      const result = await syncWorktreeFromSource(worktreePath, sourceBranch);
      return {
        ok: result.ok,
        error: result.error,
        hasConflicts: result.hasConflicts,
      };
    },

  [IPC.GIT_WORKTREE_APPRAISE]: async ({ worktreePath, sourceBranch }: { worktreePath: string; sourceBranch: string }) => {
      const appraisal = await appraiseWorktree(worktreePath, sourceBranch)
      log('appraise', {
        worktree_path: worktreePath,
        safe_to_discard: appraisal.safeToDiscard,
        uncommitted: appraisal.uncommittedPaths.length,
        unlanded: appraisal.unlandedCommitCount,
      })
      return appraisal
    },

  [IPC.GIT_WORKTREE_RETIRE_PREVIEW]: ({ worktreePath }: { worktreePath: string }) => {
      const prunedBenchPaths = predictPrunedBenches(worktreePath)
      log('retire preview', { worktree_path: worktreePath, pruned_benches: prunedBenchPaths.length })
      return { prunedBenchPaths }
    },

  [IPC.GIT_WORKTREE_SET_TITLE]: async ({
        worktreePath,
        repoPath,
        title,
      }: { worktreePath: string; repoPath?: string; title: string },
    ) => {
      if (
        !isValidProjectPath(worktreePath) ||
        (repoPath && !isValidProjectPath(repoPath))
      ) {
        warn("rename refused: invalid path", {
          worktree_path: worktreePath,
          repo_path: repoPath,
        });
        return { ok: false, error: "Invalid path." };
      }
      const trimmed = title.trim();
      const registration = lookupWorktreeRegistration(worktreePath);
      const resolvedRepo = repoPath || registration?.repoPath || "";
      if (!trimmed) {
        warn("rename refused: an empty title would leave the row unnamed", {
          worktree_path: worktreePath,
        });
        return { ok: false, error: "A title cannot be empty." };
      }

      if (
        !setWorktreeTitle(worktreePath, trimmed, { repoPath: resolvedRepo })
      ) {
        warn("rename failed to persist", {
          worktree_path: worktreePath,
          title: trimmed,
        });
        return { ok: false, error: "Could not save the registry." };
      }
      log("worktree renamed by the operator", {
        worktree_path: worktreePath,
        title: trimmed,
      });
      await announceWorktreeTitle(resolvedRepo, worktreePath, trimmed);
      return { ok: true, title: trimmed };
    },
}
