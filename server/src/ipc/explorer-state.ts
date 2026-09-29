/**
 * explorer-state fan-out — publishes an accepted file-explorer tree state to
 * every client through the server's headless `broadcast()`.
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
