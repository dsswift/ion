import type { StoreGet, StoreSet, State } from "../session-store-types";
import { rInfo, rWarn } from "../../rendererLogger";

/**
 * conflict-operation-slice — the operator's "I resolved it, carry on" and
 * "back this out" verbs for a conflicted worktree or bench directory.
 *
 * ── Why this is a store action and not a component handler ──────────────────
 * Each verb is inherently multi-step: run the Git verb in the owner window,
 * then re-read the two workspace caches the affected row is a join of. A
 * component handler chaining those calls runs in whichever window hosts it, so
 * in the Studio mirror the Git mutation would either run twice or read its
 * follow-up refresh from stale mirror state. Both actions are therefore ONE
 * store action each, classified FORWARDED in shared/studio-mirror-actions.ts
 * (ADR-021 multi-step rule).
 *
 * ── The refresh is the point ────────────────────────────────────────────────
 * Continuing or aborting changes what a worktree row SAYS: the conflict is
 * gone, `operationState` clears, and a bench member's merge verdict moves. The
 * git panel's poll is 5s and is skipped entirely while the window is hidden,
 * so without an explicit refresh a backgrounded overlay kept showing a
 * resolved conflict indefinitely. Refresh only — never reassemble. Rebuilding
 * a bench is the operator's decision, not a side effect of finishing a rebase.
 *
 * ── Operation-aware by delegation ───────────────────────────────────────────
 * The IPC channels are named for rebase but probe the real in-progress
 * operation and run the matching verb (main/ipc/git-rebase.ts), so these
 * actions work for a conflicted sync (rebase), a bench merge, or a
 * cherry-pick without knowing which.
 */

/** Result shape both verbs share. */
interface ConflictOperationResult {
  ok: boolean;
  error?: string;
}

/**
 * Resolve the repo whose workspace caches describe `directory`.
 *
 * `worktreeInventory` and `benchWorkspaces` are both keyed by REPO path, so a
 * refresh keyed by the conflicted directory would populate a cache under a key
 * no surface reads while leaving the real one stale. Returns null when the
 * directory belongs to no known workspace — a plain checkout has no worktree
 * surfaces to refresh, which is not a failure.
 */
function resolveRepoForDirectory(directory: string, get: StoreGet): string | null {
  for (const [repoPath, entries] of get().worktreeInventory) {
    if (entries.some((entry) => entry.worktreePath === directory)) return repoPath;
  }
  for (const [repoPath, workspaces] of get().benchWorkspaces) {
    if (workspaces.some((workspace) => workspace.benchPath === directory)) return repoPath;
  }
  return null;
}

/**
 * Run one conflict-operation verb, then reconcile the surfaces that describe
 * the directory. Shared by both actions because the only difference between
 * them is the IPC call and the log label — duplicating the
 * refresh-and-clear-alert tail is how the two would drift.
 */
async function runConflictOperation(
  directory: string,
  verb: "continue" | "abort",
  set: StoreSet,
  get: StoreGet,
): Promise<ConflictOperationResult> {
  const repoPath = resolveRepoForDirectory(directory, get);
  rInfo("git.conflicts", "conflict operation requested", {
    directory,
    verb,
    repo_path: repoPath ?? "",
  });

  let result: ConflictOperationResult;
  try {
    const raw = verb === "continue"
      ? await window.ion.gitRebaseContinue(directory)
      : await window.ion.gitRebaseAbort(directory);
    result = { ok: raw?.ok === true, error: raw?.error };
  } catch (error) {
    // A rejected invoke is a broken channel, not a git failure. Report it as
    // the operator-facing error rather than letting it escape as an unhandled
    // rejection that leaves the dialog spinning.
    const message = error instanceof Error ? error.message : String(error);
    rWarn("git.conflicts", "conflict operation call failed", {
      directory,
      verb,
      error: message,
    });
    return { ok: false, error: message };
  }

  if (!result.ok) {
    // The conflict is still live: keep the alert so the badge and banner stay
    // truthful. Git's own message ("no rebase in progress" for a stale button)
    // is the honest answer and is surfaced verbatim.
    rWarn("git.conflicts", "conflict operation refused", {
      directory,
      verb,
      error: result.error ?? "",
    });
    return result;
  }

  // The operation is over, so the alert this directory raised is stale. The
  // row badge and panel banner derive from live inventory state rather than
  // this map, so the refresh below is what makes them agree.
  get().clearConflictAlert(directory);

  if (repoPath) {
    await get().refreshWorkspaceViews(repoPath);
  } else {
    rInfo("git.conflicts", "no workspace surfaces to refresh for directory", {
      directory,
      verb,
    });
  }

  rInfo("git.conflicts", "conflict operation completed", {
    directory,
    verb,
    repo_path: repoPath ?? "",
  });
  return result;
}

/** The two operator verbs for an in-progress conflicted Git operation. */
export function createConflictOperationSlice(
  set: StoreSet,
  get: StoreGet,
): Partial<State> {
  return {
    continueConflictOperation: (directory) =>
      runConflictOperation(directory, "continue", set, get),
    abortConflictOperation: (directory) =>
      runConflictOperation(directory, "abort", set, get),
  };
}
