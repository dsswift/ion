/**
 * explorer-state IPC — the funnel every window uses to read and change
 * file-explorer tree state.
 *
 * Symmetric on purpose, unlike the owner/mirror sync channels: expansion is not
 * owner-durable state that only the Overlay may mutate, it is workbench state
 * either presentation can change and both must see. So this follows the
 * settings pattern instead — every window publishes to main, main persists and
 * fans the result back out, and each window converges on what main accepted.
 *
 * The publisher's `origin` rides along and comes back in the broadcast, so a
 * window can recognise its own echo and skip re-applying what it just sent.
 */
import { ipcMain } from "electron";
import { IPC } from "../../shared/types";
import { broadcast } from "../broadcast";
import { log } from "../logger";
import {
  sanitizeExplorerState,
  type ExplorerStateSnapshot,
} from "../../shared/explorer-state";
import { loadExplorerState, saveExplorerState } from "../explorer-state-store";

/** Fan the accepted snapshot to every window, tagged with who caused it. */
export function publishExplorerState(
  snapshot: ExplorerStateSnapshot,
  origin: string,
): void {
  broadcast(IPC.EXPLORER_STATE_CHANGED, { snapshot, origin });
}

export function registerExplorerStateIpc(): void {
  ipcMain.handle(IPC.LOAD_EXPLORER_STATE, () => loadExplorerState());

  ipcMain.on(IPC.PUBLISH_EXPLORER_STATE, (_event, payload: unknown) => {
    const body = payload as { snapshot?: unknown; origin?: unknown } | null;
    const origin = typeof body?.origin === "string" ? body.origin : "unknown";
    // Sanitize rather than reject: a malformed key costs that key, and a
    // rejected publish would leave the two windows silently disagreeing.
    const snapshot = sanitizeExplorerState(body?.snapshot);
    saveExplorerState(snapshot);
    log("explorer_state", "snapshot published", {
      origin,
      roots: Object.keys(snapshot.expanded).length,
      collapsed_roots: snapshot.collapsedRoots.length,
      selected_roots: Object.keys(snapshot.selected).length,
    });
    publishExplorerState(snapshot, origin);
  });
}
