/**
 * workspace-folder-migration — rewrite worktree/bench-keyed mounted folders
 * onto the Project that owns them.
 *
 * `workspaceFolders` is keyed by Project directory. Before the renderer
 * resolved the Project, "Add Folder to Workspace" in a worktree or bench tab
 * wrote a key of the checkout's own path. Nothing reads those keys now — the
 * folder would silently vanish from every surface — and a worktree key dies
 * with the worktree, so the entry has to move rather than be left behind.
 *
 * Runs once at startup, before the window opens, so the first render already
 * sees the corrected map. Idempotent: a settled file matches no known checkout
 * and is left untouched without a write.
 */
import { loadRegistry } from "./worktree/registry";
import { loadWorkspaces } from "./integration/bench-store";
import { readSettings, writeSettings } from "./settings-store";
import { log as _log, warn as _warn } from "./logger";
import { normalizeWorkspacePath } from "../shared/workspace-roots";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

/** worktree/bench path → the repo it belongs to, from the two on-disk records. */
export function buildCheckoutOwners(
  worktrees: Array<{ worktreePath: string; repoPath?: string }>,
  benches: Array<{ benchPath: string; repoPath: string }>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const entry of worktrees) {
    if (!entry.repoPath) continue;
    owners.set(
      normalizeWorkspacePath(entry.worktreePath),
      normalizeWorkspacePath(entry.repoPath),
    );
  }
  for (const bench of benches) {
    owners.set(
      normalizeWorkspacePath(bench.benchPath),
      normalizeWorkspacePath(bench.repoPath),
    );
  }
  return owners;
}

export interface RemapResult {
  /** The corrected map, or null when nothing needed moving. */
  next: Record<string, string[]> | null;
  /** One `{ from, to }` per key that moved, for the log. */
  moved: Array<{ from: string; to: string }>;
}

/**
 * Move every checkout-keyed entry onto its repo, merging into whatever that
 * repo already has and dropping duplicates. A key no record recognizes is left
 * exactly as it is: it is either a plain Project or a directory this machine
 * knows nothing about, and guessing at it would lose the operator's folders.
 */
export function remapWorkspaceFolders(
  raw: Record<string, string[]>,
  owners: Map<string, string>,
): RemapResult {
  const moved: Array<{ from: string; to: string }> = [];
  const next: Record<string, string[]> = {};

  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const from = normalizeWorkspacePath(key);
    const to = owners.get(from) ?? from;
    if (to !== from) moved.push({ from, to });
    const merged = next[to] ?? [];
    for (const entry of list) {
      const folder = typeof entry === "string" ? normalizeWorkspacePath(entry) : "";
      // The repo root is never a mounted folder of itself: a worktree-keyed
      // list could legitimately hold the base repo, which becomes a duplicate
      // of the primary root once the key moves onto that repo.
      if (!folder.startsWith("/") || folder === to || merged.includes(folder)) continue;
      merged.push(folder);
    }
    next[to] = merged;
  }

  return { next: moved.length > 0 ? next : null, moved };
}

/**
 * Read settings, remap, write back only when something moved. Never throws:
 * a failure here must not stop the app from starting, and the worst outcome is
 * that a stranded folder stays stranded until the next launch.
 */
export function migrateWorkspaceFolders(): void {
  try {
    const settings = readSettings();
    const raw = settings.workspaceFolders;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      log("workspace folder migration: no map to migrate");
      return;
    }
    const owners = buildCheckoutOwners(loadRegistry(), loadWorkspaces());
    const { next, moved } = remapWorkspaceFolders(
      raw as Record<string, string[]>,
      owners,
    );
    if (!next) {
      log("workspace folder migration: no checkout-keyed entries", {
        keys: Object.keys(raw).length,
        known_checkouts: owners.size,
      });
      return;
    }
    for (const move of moved) {
      log("workspace folder migration: remapped key", {
        from: move.from,
        to: move.to,
      });
    }
    writeSettings({ ...settings, workspaceFolders: next });
    log("workspace folder migration: wrote corrected map", {
      moved: moved.length,
      keys: Object.keys(next).length,
    });
  } catch (err) {
    _warn("main", "workspace folder migration failed", { error: String(err) });
  }
}
