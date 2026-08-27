import { ipcMain } from "electron";
import { IPC } from "../../shared/types";
import { runGit } from "../git-runner";
import { landWorktree, syncWorktreeFromSource } from "../worktree/integrate";

/**
 * Register the worktree IPC operations that directly invoke git actions.
 *
 * Kept separate from `worktree.ts`, which owns provisioning, registration,
 * titles, stages, and read-only worktree inspection.
 */
export function registerWorktreeGitIpc(): void {
  // GIT_WORKTREE_MERGE is retained as a channel (no wire removal) but its body
  // now DELEGATES to landWorktree. The original implementation ran a bare
  // `git checkout <sourceBranch>` in the main repo followed by `merge
  // --ff-only`, which clobbered the operator's checkout, could not be repeated
  // after another worktree landed, and raced other tabs. Routing through the
  // land path means no caller can bypass the dirty/branch preflight or the
  // per-repo serialization. See main/worktree/integrate.ts.
  ipcMain.handle(
    IPC.GIT_WORKTREE_MERGE,
    async (
      _event,
      {
        repoPath,
        worktreeBranch,
        sourceBranch,
        noFf,
        worktreePath,
      }: {
        repoPath: string;
        worktreeBranch: string;
        sourceBranch: string;
        noFf?: boolean;
        worktreePath?: string;
      },
    ) => {
      return landWorktree({
        repoPath,
        // Older callers of this channel did not pass worktreePath. The land
        // preflight uses it only for the "is the worktree committed" gate;
        // falling back to repoPath keeps those callers working (the gate then
        // checks the repo, which is the conservative direction).
        worktreePath: worktreePath || repoPath,
        worktreeBranch,
        sourceBranch,
        noFf,
      });
    },
  );

  ipcMain.handle(
    IPC.GIT_WORKTREE_PUSH,
    async (_event, { worktreePath }: { worktreePath: string }) => {
      try {
        await runGit(worktreePath, ["push", "-u", "origin", "HEAD"]);
        const remoteUrl = (
          await runGit(worktreePath, ["remote", "get-url", "origin"])
        ).trim();
        const remoteBranch = (
          await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
        ).trim();
        return { ok: true, remoteBranch, remoteUrl };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  );

  // The rebase body DELEGATES to syncWorktreeFromSource rather than running its
  // own `git rebase`. The original implementation detected conflicts with
  // `msg.includes('CONFLICT')` — the exact string-match defect hasMergeConflict
  // (worktree/integrate.ts) documents: git writes "CONFLICT (...)" lines to
  // STDOUT, which the error path does not capture, so a genuine conflict was
  // misreported as an unknown failure. Routing through the sync verb gives this
  // channel the precise unmerged-index probe, the dirty-tree preflight, and
  // every future sync improvement for free. The `fetch origin` stays: this
  // channel's callers (the git graph's Pull-in-a-worktree) expect the remote to
  // be refreshed before rebasing onto the source branch.
  ipcMain.handle(
    IPC.GIT_WORKTREE_REBASE,
    async (
      _event,
      {
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
  );
}
