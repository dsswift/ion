/**
 * explorer-state-cleanup — forget the explorer tree state of directories that
 * no longer exist, and tell the open windows.
 *
 * Separate from explorer-state-store so the worktree lifecycle depends on this
 * one small function rather than on the IPC layer: the store persists, this
 * decides when a removal is worth a broadcast, and the store never imports
 * Electron.
 */
import { forgetExplorerState } from "./explorer-state-store";
import { publishExplorerState } from "./ipc/explorer-state";
import { log } from "./logger";

/**
 * Drop the recorded tree state for each directory and its descendants.
 *
 * Broadcasts once, and only when something actually changed — a retire of a
 * checkout the operator never opened in the explorer should cost nothing.
 */
export function forgetExplorerStateForDirectories(directories: string[]): void {
  let changedAny = false;
  let latest = null as ReturnType<typeof forgetExplorerState>["snapshot"] | null;
  for (const directory of directories) {
    if (!directory) continue;
    const { snapshot, changed } = forgetExplorerState(directory);
    latest = snapshot;
    changedAny = changedAny || changed;
  }
  if (!changedAny || !latest) return;
  log("explorer_state", "forgot retired directories", {
    directories: directories.filter(Boolean).length,
  });
  publishExplorerState(latest, "main");
}
