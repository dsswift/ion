/**
 * Ephemeral worktree records — the registry half of "a worktree that closes
 * with its conversation".
 *
 * An ephemeral worktree is cut for one conversation (`ephemeral.ownerTabId`).
 * When that conversation closes, the store's close path appraises it the way
 * Retire does: nothing unlanded removes it, anything else keeps it. A kept
 * worktree stops being ephemeral for good and records why
 * (`ephemeralKept`), which the worktree list shows the operator.
 *
 * The owner is bound separately from registration because a new conversation's
 * worktree is cut before the conversation's id exists.
 */
import { log as _log, warn as _warn } from "../logger";
import { invalidateWorktreeInventoryCache } from "./inventory-cache";
import { loadRegistry, saveRegistry } from "./registry";

const TAG = "worktree.ephemeral";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}

/** Tie an ephemeral worktree to the conversation it was cut for. */
export function setEphemeralWorktreeOwner(
  worktreePath: string,
  ownerTabId: string,
): boolean {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.worktreePath === worktreePath);
  if (!entry?.ephemeral) {
    warn("owner not bound: worktree is not ephemeral", {
      worktree_path: worktreePath,
      tab_id: ownerTabId,
      registered: !!entry,
    });
    return false;
  }
  entry.ephemeral = { ownerTabId };
  const saved = saveRegistry(entries);
  if (saved) {
    invalidateWorktreeInventoryCache("ephemeral worktree owner bound");
    log("ephemeral worktree owner bound", {
      worktree_path: worktreePath,
      tab_id: ownerTabId,
    });
  }
  return saved;
}

/**
 * Turn an ephemeral worktree into an ordinary one, recording why its
 * conversation's close kept it. Idempotent: an ordinary worktree is left as is.
 */
export function keepEphemeralWorktree(
  worktreePath: string,
  reason: string,
): boolean {
  const entries = loadRegistry();
  const entry = entries.find((e) => e.worktreePath === worktreePath);
  if (!entry?.ephemeral) {
    log("keep skipped: worktree is not ephemeral", {
      worktree_path: worktreePath,
      registered: !!entry,
    });
    return true;
  }
  const ownerTabId = entry.ephemeral.ownerTabId ?? "";
  delete entry.ephemeral;
  entry.ephemeralKept = { at: Date.now(), reason };
  const saved = saveRegistry(entries);
  if (saved) {
    invalidateWorktreeInventoryCache("ephemeral worktree kept");
    log("ephemeral worktree kept as an ordinary worktree", {
      worktree_path: worktreePath,
      tab_id: ownerTabId,
      reason,
    });
  }
  return saved;
}

/** The ephemeral state the worktree list shows for one worktree. */
export function lookupEphemeralState(worktreePath: string): {
  ephemeral: boolean;
  keptReason?: string;
} {
  const entry = loadRegistry().find((e) => e.worktreePath === worktreePath);
  return {
    ephemeral: !!entry?.ephemeral,
    keptReason: entry?.ephemeralKept?.reason,
  };
}
