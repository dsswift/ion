/**
 * Bridged `host.shell` verbs, worktrees domain: every one is served by a
 * `studio_action` or `studio_event` on every host (`browser-shell-bridge.ts`),
 * so the Electron preload no longer carries it. Moved verbatim from the
 * preload's `ionapi-worktrees.ts` (spec 12: `IonAPI` shrinks toward the natives and the
 * host relay, `ShellApi` keeps the full surface).
 */
import type { WorktreeAppraisalWire } from "@ion/shared/types";

export interface BridgedWorktreesShell {
  gitWorktreeRebase(
    worktreePath: string,
    sourceBranch: string,
  ): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean }>;
  /** Operator override for a worktree's title. */
  gitWorktreeSetTitle(args: {
    worktreePath: string;
    repoPath?: string;
    title: string;
  }): Promise<{ ok: boolean; title?: string; error?: string }>;
  /** What would be lost if this worktree were removed right now. */
  gitWorktreeAppraise(
    worktreePath: string,
    sourceBranch: string,
  ): Promise<WorktreeAppraisalWire>;
  /**
   * Read-only preview of a retire's blast radius: the bench directories the
   * retire would remove because disenrolling this worktree empties them.
   *
   * Asked BEFORE the retire so the caller can refuse when a conversation living
   * in one of those directories is still active. Mutates nothing.
   */
  gitWorktreeRetirePreview(
    worktreePath: string,
  ): Promise<{ prunedBenchPaths: string[] }>;
  /**
   * Whether a worktree conversation cut in `repoPath` is ephemeral when the
   * create does not say: the project's remembered choice, else its
   * `.ion/worktree.json`.
   */
  gitWorktreeEphemeralDefault(
    repoPath: string,
  ): Promise<{ ephemeral: boolean; source: "project" | "manifest" }>;
}
