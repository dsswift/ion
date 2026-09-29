/**
 * explorer-state IPC (headless) — the server-side half of the funnel every
 * window uses to read and change file-explorer tree state.
 *
 * The desktop's `desktop/src/main/ipc/explorer-state.ts` keeps the
 * Electron-bound half: `ipcMain.handle`/`ipcMain.on` registration, which has
 * no headless equivalent. `publishExplorerState` itself has no Electron
 * dependency beyond the fan-out mechanism, so it lives here too, routed
 * through the server's headless `broadcast()` placeholder
 * (`server/src/broadcast.ts`) — the same pattern `explorer-state-cleanup.ts`
 * already depends on.
 */
import { IPC } from "@ion/shared/types";
import { broadcast } from "../broadcast";
import type { ExplorerStateSnapshot } from "@ion/shared/explorer-state";

/** Fan the accepted snapshot to every window, tagged with who caused it. */
export function publishExplorerState(
  snapshot: ExplorerStateSnapshot,
  origin: string,
): void {
  broadcast(IPC.EXPLORER_STATE_CHANGED, { snapshot, origin });
}
