/**
 * explorer-state-store — the one owner of file-explorer tree state.
 *
 * The Overlay and the Studio are two windows onto one workbench, so expansion
 * cannot live in either renderer: whichever one the operator is not looking at
 * would hold a stale copy, and quitting would throw both away. Main holds the
 * snapshot, writes the durable part to its own file, and every window reads and
 * publishes through it.
 *
 * It is deliberately NOT in settings.json. An expansion set for a large project
 * is long and machine-written; settings.json is a file the operator reads.
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { SETTINGS_DIR } from "./settings-store";
import { atomicWriteFileSync } from "./utils/atomicWrite";
import { log as _log, warn as _warn } from "./logger";
import {
  EMPTY_EXPLORER_STATE,
  forgetExplorerStateUnder,
  sanitizeExplorerState,
  toPersistedExplorerState,
  type ExplorerStateSnapshot,
} from "../shared/explorer-state";

export const EXPLORER_STATE_FILE = join(SETTINGS_DIR, "explorer-state.json");

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("explorer_state", msg, fields);
}

/**
 * In-memory truth, seeded lazily from disk. Selection is intentionally empty on
 * the first read: it is shared between live windows only.
 */
let snapshot: ExplorerStateSnapshot | null = null;

export function loadExplorerState(): ExplorerStateSnapshot {
  if (snapshot) return snapshot;
  if (!existsSync(EXPLORER_STATE_FILE)) {
    log("no explorer state file yet, starting empty", { path: EXPLORER_STATE_FILE });
    snapshot = EMPTY_EXPLORER_STATE;
    return snapshot;
  }
  try {
    const parsed = sanitizeExplorerState(JSON.parse(readFileSync(EXPLORER_STATE_FILE, "utf-8")));
    snapshot = parsed;
    log("explorer state loaded", {
      path: EXPLORER_STATE_FILE,
      roots: Object.keys(parsed.expanded).length,
      collapsed_roots: parsed.collapsedRoots.length,
    });
    return snapshot;
  } catch (err) {
    // A corrupt file costs expanded folders, nothing else. Starting empty beats
    // failing the explorer.
    _warn("explorer_state", "failed to read explorer state, starting empty", {
      path: EXPLORER_STATE_FILE,
      error: String(err),
    });
    snapshot = EMPTY_EXPLORER_STATE;
    return snapshot;
  }
}

/** Replace the snapshot and write the durable part. */
export function saveExplorerState(next: ExplorerStateSnapshot): ExplorerStateSnapshot {
  snapshot = next;
  try {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    atomicWriteFileSync(
      EXPLORER_STATE_FILE,
      JSON.stringify(toPersistedExplorerState(next), null, 2),
      0o644,
    );
    log("explorer state written", {
      roots: Object.keys(next.expanded).length,
      collapsed_roots: next.collapsedRoots.length,
    });
  } catch (err) {
    // The in-memory snapshot still stands, so the live windows stay converged;
    // only the restore after the next launch is lost.
    _warn("explorer_state", "failed to write explorer state", {
      path: EXPLORER_STATE_FILE,
      error: String(err),
    });
  }
  return snapshot;
}

/**
 * Forget a directory and everything under it, for a checkout that no longer
 * exists. Returns the snapshot when nothing matched so the caller can skip the
 * write and the broadcast.
 */
export function forgetExplorerState(directory: string): {
  snapshot: ExplorerStateSnapshot;
  changed: boolean;
} {
  const current = loadExplorerState();
  const next = forgetExplorerStateUnder(current, directory);
  if (next === current) {
    log("explorer state had nothing recorded for the retired directory", {
      directory,
    });
    return { snapshot: current, changed: false };
  }
  log("explorer state forgetting retired directory", {
    directory,
    roots_before: Object.keys(current.expanded).length,
    roots_after: Object.keys(next.expanded).length,
  });
  return { snapshot: saveExplorerState(next), changed: true };
}

/** Test seam: drop the memoized snapshot so the next read re-pulls disk. */
export function resetExplorerStateCache(): void {
  snapshot = null;
}
