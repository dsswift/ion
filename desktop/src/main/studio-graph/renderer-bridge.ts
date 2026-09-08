/**
 * The main → Studio-renderer command seam for graph tools.
 *
 * Main owns the tool declarations; it does NOT own the graph. The Studio
 * renderer holds the graph store (model, layout, selection, camera), so
 * every graph tool call is a request the renderer applies and acknowledges.
 *
 * The sender is injected rather than imported to keep this module free of
 * Electron: the IPC layer registers the real one at window creation, and
 * tests install a fake. When nothing is registered, callers get `null` and
 * must surface a model-visible "Studio required" error rather than
 * pretending the call succeeded.
 */
import type { StudioGraphCommand, StudioGraphCommandResult } from '../../shared/studio-graph-types'

export type GraphCommandSender = (command: StudioGraphCommand, timeoutMs: number) => Promise<StudioGraphCommandResult>

let sender: GraphCommandSender | null = null

/** Install (or clear, with null) the live Studio renderer command sender. */
export function setGraphCommandSender(next: GraphCommandSender | null): void {
  sender = next
}

export function graphCommandSender(): GraphCommandSender | null {
  return sender
}
