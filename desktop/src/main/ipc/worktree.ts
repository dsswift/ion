import { ipcMain } from "electron";
import { mkdirSync, readdirSync, rmSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { basename, join } from "path";
import { IPC } from "../../shared/types";
import type { WorktreeInfo, WorktreeStatus } from "../../shared/types";
import { workStageDescriptor, type WorkStage } from "../../shared/types-git";
import { isValidProjectPath } from "../ipc-validation";
import { runGit } from "../git-runner";
import { registerWorktreeGitIpc } from "./worktree-git";
import {
  lookupWorktreeRegistration,
  registerWorktree,
  setWorktreeStage,
  setWorktreeTitle,
  unregisterWorktree,
} from "../worktree/inventory";
import { provisionWorktree } from "../worktree/provision";
import {
  setProvisionState,
  clearProvisionState,
} from "../worktree/provision-state";
import { announceWorktreeTitle } from "../worktree/title-announce";
import { triggerWorktreeLifecycleAutomation } from "../worktree/lifecycle-automation-trigger";
import { log as _log, warn as _warn } from "../logger";

const TAG = "worktree.title";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}

export function registerWorktreeIpc(): void {
  ipcMain.handle(
    IPC.GIT_WORKTREE_ADD,
    async (
      _event,
      { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string },
    ) => {
      try {
        // ONE identity for the worktree, used for both the directory and the
        // branch. These used to be two independent randomBytes() calls, so a
        // worktree at `ion-452a6bd3` carried branch `wt/807940c2` — nothing
        // connected them, the row label showed the directory while every git
        // verb and every agent sentence used the branch, and the operator had to
        // consult the registry to map one to the other.
        //
        // Deriving both from one slug makes the mapping trivial in either
        // direction (`ion-a3372546` ⇄ `wt/ion-a3372546`), so a single label can
        // identify the worktree everywhere.
        const slug = `${basename(repoPath)}-${randomBytes(4).toString("hex")}`;
        const branchName = `wt/${slug}`;
        const worktreeDir = join(homedir(), ".ion", "worktrees");
        const worktreePath = join(worktreeDir, slug);
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
        // Record the source branch: git does not store which branch a worktree
        // was cut from, and every lifecycle verb (land, sync, base staleness)
        // needs it. Without this the inventory has to guess, and a wrong guess
        // would land work into the wrong branch.
        //
        // The BASE (the source tip just checked out) is recorded for the same
        // reason: it cannot be derived after the source branch is rebased, and
        // the sync verb needs it to replay only this worktree's own commits.
        // Read from the fresh worktree's HEAD — by construction it IS the source
        // tip, and reading it locally cannot race a concurrent land advancing
        // the branch. Failure to read it degrades to the plain-rebase fallback.
        let baseSha: string | undefined;
        try {
          baseSha = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
        } catch (err) {
          warn("could not resolve base sha for new worktree", {
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
            baseSha,
          })
        ) {
          registryWarning = "Worktree created but registry persist failed.";
          warn("worktree created but registry persist failed", {
            worktree_path: worktreePath,
          });
        }

        // Provisioning runs BEHIND the worktree, not in front of it: the operator
        // gets a usable directory immediately and watches the dependency state
        // fill in. A cold `npm ci` would otherwise block worktree creation for
        // minutes. Fire-and-forget with `void` — every failure is captured into
        // provisionState rather than thrown, so there is nothing to await here.
        setProvisionState(worktreePath, "seeding");
        void provisionWorktree(repoPath, worktreePath, (state, detail) => {
          setProvisionState(worktreePath, state, detail);
        }).catch((err) => {
          // Defensive: provisionWorktree is documented never to reject. If that
          // contract is ever broken the worktree must still end in a terminal
          // state rather than sitting in `seeding` forever.
          setProvisionState(worktreePath, "failed", String(err));
        });

        if (!registryWarning) {
          await triggerWorktreeLifecycleAutomation("worktree:created", {
            repoPath,
            worktreePath,
            branchName,
            sourceBranch,
            baseSha: baseSha ?? "",
            source: "create",
          });
        }
        return { ok: true, worktree, warning: registryWarning };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_WORKTREE_REMOVE,
    async (
      _event,
      {
        repoPath,
        worktreePath,
        branchName,
        force,
      }: {
        repoPath: string;
        worktreePath: string;
        branchName: string;
        force?: boolean;
      },
    ) => {
      try {
        const removeArgs = ["worktree", "remove", worktreePath];
        if (force) removeArgs.push("--force");
        await runGit(repoPath, removeArgs);
        try {
          await runGit(repoPath, ["branch", "-D", branchName]);
        } catch {
          /* silent-ok: best-effort branch delete; worktree already removed */
        }
        let registryWarning: string | undefined;
        if (!unregisterWorktree(worktreePath)) {
          registryWarning = "Worktree removed but registry persist failed.";
          warn("worktree removed but registry persist failed", {
            worktree_path: worktreePath,
          });
        }
        // Drop the provisioning record too: a future worktree reusing this path
        // must start with no state rather than inheriting a stale `failed`.
        clearProvisionState(worktreePath);
        try {
          const parent = join(worktreePath, "..");
          const entries = readdirSync(parent);
          if (entries.length === 0) rmSync(parent, { recursive: true });
        } catch {
          /* silent-ok: best-effort removal of the now-empty worktree parent dir */
        }
        return { ok: true, warning: registryWarning };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  );

  // Re-provision: re-run the ladder for a worktree whose dependency state the
  // operator believes is wrong. Deliberately the SAME path creation uses, so a
  // repair can never drift from a fresh provision.
  //
  // Awaited (unlike creation) because the caller asked for it explicitly and
  // wants to know the outcome.
  ipcMain.handle(
    IPC.GIT_WORKTREE_REPROVISION,
    async (
      _event,
      { repoPath, worktreePath }: { repoPath: string; worktreePath: string },
    ) => {
      setProvisionState(worktreePath, "seeding");
      const outcome = await provisionWorktree(
        repoPath,
        worktreePath,
        (state, detail) => {
          setProvisionState(worktreePath, state, detail);
        },
      );
      return {
        ok: outcome.state === "ready",
        state: outcome.state,
        error: outcome.error,
      };
    },
  );

  /**
   * Record a worktree's human title, seeded from the conversation that named
   * itself first. Called by the renderer once per generated tab title; the
   * DECISION about whether it applies lives here.
   *
   * ── A recording, not a generation ────────────────────────────────────────
   * This handler used to call `generateTitle` itself, on the same prompt text
   * the renderer had just used to title the tab. Two round-trips over one
   * prompt produced two independently-worded names for one piece of work, and
   * they drifted from the moment they were written. The renderer now generates
   * ONCE and passes the resulting string here, so the tab and the worktree
   * carry the same name at the same moment. Nothing on this path talks to a
   * model.
   *
   * ── Why the main process decides ────────────────────────────────────────
   * "Is this directory a worktree, and has it been named yet?" is answered by
   * the registry, which is main-process state. A renderer-side check would read
   * the inventory snapshot it happens to hold — stale in the Studio mirror, absent
   * in a window that never opened the git panel — and both windows would race
   * on the same send. Deciding here means the answer is read from the one
   * authoritative record.
   *
   * That record is also what makes "FIRST PROMPT WINS" true by construction.
   * Several conversations routinely share one worktree; each of their first
   * sends reaches this handler. The already-titled guard refuses every seed
   * after the first, so a worktree's topic never changes because a second tab
   * was opened in it to chase a bug.
   *
   * Three no-op paths, each logged so the decision is reconstructable:
   *   - the directory is not a registered worktree (an ordinary project tab),
   *   - it already has a title (the common case after the first prompt),
   *   - the seed carries no usable text.
   *
   * Failure is never fatal to the prompt that triggered it: the row keeps
   * showing its machine slug and the next fresh conversation seeds it.
   */
  ipcMain.handle(
    IPC.GIT_WORKTREE_SEED_TITLE,
    async (
      _event,
      { worktreePath, title }: { worktreePath: string; title: string },
    ) => {
      const trimmed = title?.trim() ?? "";
      if (!worktreePath || !trimmed) {
        log("seed skipped: nothing to work from", {
          worktree_path: worktreePath,
          title_len: title?.length ?? 0,
        });
        return { ok: false, reason: "empty-input" as const };
      }
      if (!isValidProjectPath(worktreePath)) {
        warn("seed refused: invalid worktree path", {
          worktree_path: worktreePath,
        });
        return { ok: false, reason: "invalid-path" as const };
      }

      const registration = lookupWorktreeRegistration(worktreePath);
      if (!registration) {
        log("seed skipped: not a registered worktree", { dir: worktreePath });
        return { ok: false, reason: "not-a-worktree" as const };
      }
      if (registration.title) {
        log("seed skipped: already titled", {
          worktree_path: worktreePath,
          title: registration.title,
        });
        return {
          ok: false,
          reason: "already-titled" as const,
          title: registration.title,
        };
      }

      if (!setWorktreeTitle(worktreePath, trimmed)) {
        warn("seed title failed to persist", {
          worktree_path: worktreePath,
          title: trimmed,
        });
        return { ok: false, reason: "persist-failed" as const };
      }
      log("seed applied", {
        worktree_path: worktreePath,
        repo_path: registration.repoPath,
        branch: registration.branchName,
        title: trimmed,
      });
      await announceWorktreeTitle(registration.repoPath, worktreePath, trimmed);
      return { ok: true, title: trimmed };
    },
  );

  /**
   * Operator override for a worktree's title — the escape hatch when the
   * generated one is wrong. Upserts, so a hand-created worktree with no
   * registry entry can still be named (it is recorded with an unknown source
   * branch rather than a guessed one).
   */
  ipcMain.handle(
    IPC.GIT_WORKTREE_SET_TITLE,
    async (
      _event,
      {
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
  );

  /**
   * Set or clear the operator's workflow stage on a worktree. Upserts like
   * SET_TITLE (a hand-created worktree can carry a stage; the new entry
   * records an unknown source branch rather than a guessed one), and pushes
   * the worktree state to iOS so the phone's row updates without waiting for
   * its next manual refresh.
   */
  ipcMain.handle(
    IPC.GIT_WORKTREE_SET_STAGE,
    async (
      _event,
      {
        worktreePath,
        repoPath,
        stage,
      }: { worktreePath: string; repoPath?: string; stage: WorkStage | null },
    ) => {
      if (
        !isValidProjectPath(worktreePath) ||
        (repoPath && !isValidProjectPath(repoPath))
      ) {
        warn("stage refused: invalid path", {
          worktree_path: worktreePath,
          repo_path: repoPath,
        });
        return { ok: false, error: "Invalid path." };
      }
      if (stage !== null && !workStageDescriptor(stage)) {
        warn("stage refused: unknown value", {
          worktree_path: worktreePath,
          stage: String(stage),
        });
        return { ok: false, error: "Unknown work stage." };
      }
      const registration = lookupWorktreeRegistration(worktreePath);
      const resolvedRepo = repoPath || registration?.repoPath || "";
      if (
        !setWorktreeStage(
          worktreePath,
          stage,
          { repoPath: resolvedRepo },
          { kind: "operator" },
        )
      ) {
        warn("stage set failed to persist", {
          worktree_path: worktreePath,
          stage: stage ?? "none",
        });
        return { ok: false, error: "Could not save the registry." };
      }
      log("worktree stage set by the operator", {
        worktree_path: worktreePath,
        stage: stage ?? "none",
      });
      if (resolvedRepo) {
        try {
          const { pushWorktreeState } =
            await import("../remote/handlers/worktree");
          await pushWorktreeState(resolvedRepo);
        } catch (err) {
          // The desktop rows are already correct; only the phone is briefly
          // stale, and its next refresh corrects it. Never fatal to the set.
          warn("could not push worktree state after a stage change", {
            repo_path: resolvedRepo,
            worktree_path: worktreePath,
            error: String(err),
          });
        }
      }
      return { ok: true, stage };
    },
  );

  ipcMain.handle(
    IPC.GIT_WORKTREE_LIST,
    async (_event, { repoPath }: { repoPath: string }) => {
      try {
        const raw = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
        const worktrees: Array<{ path: string; branch: string; head: string }> =
          [];
        const blocks = raw.trim().split("\n\n");
        for (const block of blocks) {
          if (!block.trim()) continue;
          const lines = block.trim().split("\n");
          let wtPath = "";
          let head = "";
          let branch = "";
          for (const line of lines) {
            if (line.startsWith("worktree "))
              wtPath = line.slice("worktree ".length);
            else if (line.startsWith("HEAD "))
              head = line.slice("HEAD ".length);
            else if (line.startsWith("branch "))
              branch = line.slice("branch refs/heads/".length);
          }
          if (wtPath) worktrees.push({ path: wtPath, branch, head });
        }
        return { worktrees };
      } catch {
        return { worktrees: [] };
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_WORKTREE_STATUS,
    async (
      _event,
      {
        worktreePath,
        sourceBranch,
      }: { worktreePath: string; sourceBranch: string },
    ) => {
      try {
        const statusOutput = await runGit(worktreePath, [
          "status",
          "--porcelain",
        ]);
        const hasUncommittedChanges = statusOutput.trim().length > 0;

        let aheadCount = 0;
        let behindCount = 0;
        try {
          const ahead = await runGit(worktreePath, [
            "rev-list",
            "--count",
            `${sourceBranch}..HEAD`,
          ]);
          aheadCount = parseInt(ahead.trim(), 10) || 0;
        } catch {
          /* silent-ok: no upstream/ref yet; ahead count stays 0 */
        }
        try {
          const behind = await runGit(worktreePath, [
            "rev-list",
            "--count",
            `HEAD..${sourceBranch}`,
          ]);
          behindCount = parseInt(behind.trim(), 10) || 0;
        } catch {
          /* silent-ok: no upstream/ref yet; behind count stays 0 */
        }

        let isMerged = false;
        try {
          await runGit(worktreePath, [
            "merge-base",
            "--is-ancestor",
            "HEAD",
            sourceBranch,
          ]);
          isMerged = true;
        } catch {
          /* silent-ok: non-zero exit means HEAD is not an ancestor; isMerged stays false */
        }

        const status: WorktreeStatus = {
          hasUncommittedChanges,
          hasUnpushedCommits: aheadCount > 0,
          isMerged,
          aheadCount,
          behindCount,
        };
        return status;
      } catch {
        return {
          hasUncommittedChanges: false,
          hasUnpushedCommits: false,
          isMerged: false,
          aheadCount: 0,
          behindCount: 0,
        };
      }
    },
  );

  registerWorktreeGitIpc();
}
