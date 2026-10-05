import { log as _log, warn as _warn } from "../logger";
import { workStageDescriptor, type WorkStage } from "@ion/shared/types-git";
import { invalidateWorktreeInventoryCache } from "./inventory-cache";
import { loadRegistry, saveRegistry } from "./registry";

const TAG = "worktree.registry";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}

/** A worktree's recorded title, or null when it has never been named. */
export function lookupWorktreeTitle(worktreePath: string): string | null {
  return (
    loadRegistry().find((entry) => entry.worktreePath === worktreePath)?.title ??
    null
  );
}

/** A worktree's recorded workflow stage, or null when none is set. */
export function lookupWorktreeStage(worktreePath: string): WorkStage | null {
  const raw = loadRegistry().find(
    (entry) => entry.worktreePath === worktreePath,
  )?.stage;
  // Filtered through the descriptor table so a hand-edited or future-version
  // value degrades to "no stage" instead of leaking an unknown string to
  // every renderer.
  return workStageDescriptor(raw)?.id ?? null;
}

/** When this worktree's work landed, or null when it has not (or Ion has no record). */
export function lookupWorktreeLandedAt(worktreePath: string): number | null {
  return (
    loadRegistry().find((entry) => entry.worktreePath === worktreePath)
      ?.landedAt ?? null
  );
}

/**
 * The full registration for a worktree, or null when Ion has no record.
 *
 * Callers that must decide "is this directory a worktree Ion manages, and which
 * repo does it belong to" read this rather than inferring from the path shape —
 * a path can look like a worktree without being one.
 */
export function lookupWorktreeRegistration(worktreePath: string): {
  repoPath: string;
  branchName: string;
  sourceBranch: string | null;
  title: string | null;
  awaitingFirstPrompt: boolean;
  landedAt?: number;
  ephemeral?: { ownerTabId?: string };
} | null {
  const entry = loadRegistry().find(
    (candidate) => candidate.worktreePath === worktreePath,
  );
  if (!entry) return null;
  return {
    repoPath: entry.repoPath,
    branchName: entry.branchName,
    sourceBranch: entry.sourceBranch,
    title: entry.title ?? null,
    awaitingFirstPrompt: entry.awaitingFirstPrompt === true,
    landedAt: entry.landedAt,
    ephemeral: entry.ephemeral,
  };
}

/**
 * Record that a conversation has sent its first prompt in this worktree, which
 * ends the worktree's chance to be named automatically.
 *
 * Returns whether this call was the one that ended it. A worktree with no
 * registry entry, or one whose window was already closed, is a logged no-op.
 */
export function closeWorktreeTitleSeed(worktreePath: string): boolean {
  const entries = loadRegistry();
  const existing = entries.find((e) => e.worktreePath === worktreePath);
  if (!existing?.awaitingFirstPrompt) {
    log("worktree title seed already closed", {
      worktree_path: worktreePath,
      registered: !!existing,
    });
    return false;
  }
  delete existing.awaitingFirstPrompt;
  const saved = saveRegistry(entries);
  if (saved) {
    log("worktree title seed closed", {
      worktree_path: worktreePath,
      title: existing.title ?? "",
    });
  }
  return saved;
}

/** Drop a worktree's registry entry (after a retire). */
export function unregisterWorktree(worktreePath: string): boolean {
  const before = loadRegistry();
  const after = before.filter((entry) => entry.worktreePath !== worktreePath);
  if (after.length !== before.length) {
    const saved = saveRegistry(after);
    if (saved) {
      invalidateWorktreeInventoryCache("worktree unregistered");
      log("unregistered worktree", { worktree_path: worktreePath });
    }
    return saved;
  }
  return true;
}

/** Look up a worktree's recorded source branch, or null when unknown. */
export function lookupSourceBranch(worktreePath: string): string | null {
  return (
    loadRegistry().find((entry) => entry.worktreePath === worktreePath)
      ?.sourceBranch ?? null
  );
}

/**
 * The source-branch commit this worktree is based on, or null when the record
 * predates base tracking (or Ion has no record). See the `baseSha` field
 * comment for why this is stored rather than derived.
 */
export function lookupWorktreeBase(worktreePath: string): string | null {
  return (
    loadRegistry().find((entry) => entry.worktreePath === worktreePath)
      ?.baseSha ?? null
  );
}

/**
 * Advance a worktree's recorded base after a successful sync.
 *
 * Called only from the sync path (worktree/integrate.ts), which is the only
 * code that witnesses the transition — after `git rebase --onto <source>` the
 * worktree is based on the tip the sync captured, and recording anything else
 * (or nothing) would send the NEXT sync through the imprecise fallback.
 *
 * A worktree with no registry entry is not created here, for the same reason
 * `markWorktreeLanded` refuses to: inventing an entry with a fabricated
 * `sourceBranch` is the failure mode the registry's null-source rule prevents.
 */
export function setWorktreeBase(
  worktreePath: string,
  baseSha: string,
): boolean {
  const entries = loadRegistry();
  const existing = entries.find(
    (entry) => entry.worktreePath === worktreePath,
  );
  if (!existing) {
    warn("cannot record base, no registry entry", {
      worktree_path: worktreePath,
    });
    return false;
  }
  const previous = existing.baseSha;
  existing.baseSha = baseSha;
  const saved = saveRegistry(entries);
  if (saved) {
    log("worktree base advanced", {
      worktree_path: worktreePath,
      base_sha: baseSha.slice(0, 7),
      previous: (previous ?? "").slice(0, 7),
    });
  }
  return saved;
}

/**
 * Every registered worktree's checkout path.
 *
 * Used by the git watcher's exemption list (git/watcher-exempt.ts): a worktree
 * lives under `~/.ion/worktrees/`, which the default ignore rule covers, and
 * without knowing these paths the watcher treats a real source checkout as
 * Ion's own data and never fires for it.
 *
 * Landed worktrees are included. The checkout stays on disk as a read-only
 * review record, and a reviewer reading its diff needs the panel to reflect
 * the file they are looking at.
 */
export function registeredWorktreePaths(): string[] {
  return loadRegistry().map((entry) => entry.worktreePath).filter(Boolean)
}

/**
 * Every distinct repo that has at least one registered worktree.
 *
 * The freshness poll (worktree/freshness-poll.ts) needs to know WHICH repos to
 * crawl without a renderer telling it, because the renderer telling it is
 * exactly the coupling that let the Inbox go stale: the only refresh trigger
 * was a component effect keyed on a token that almost never changed, so after
 * first mount nothing re-read git for hours.
 *
 * The registry is the right source because it is the durable record of what
 * Ion manages, it is already the thing the crawl joins against, and it is
 * readable from main with no window open. Entries whose `repoPath` was never
 * recorded (a hand-created worktree that was only ever titled — see
 * `setWorktreeTitle`, which writes `repoPath: ''`) are skipped: an empty path
 * is not a repo, and handing it to the crawl would spawn git in the wrong cwd.
 *
 * Landed worktrees still count. Their repo may hold other active worktrees,
 * and the landed row itself remains visible as a review record until retired.
 */
export function registeredRepoPaths(): string[] {
  const seen = new Set<string>()
  for (const entry of loadRegistry()) {
    if (entry.repoPath) seen.add(entry.repoPath)
  }
  return [...seen]
}
