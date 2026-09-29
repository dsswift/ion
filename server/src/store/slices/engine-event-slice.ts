/**
 * engine-event-slice — WI-001 residual
 *
 * After the single-path collapse (WI-001), all engine events flow through
 * the normalized stream (ion:normalized-event → handleNormalizedEvent in
 * event-slice.ts). This file retains:
 *
 *   - cleanupTabDeltas: no-op stub for tab-slice.ts API compatibility
 *   - getRendererExtensionCommands: renderer-side autocomplete hint cache
 *     (still updated via command_registry NormalizedEvent in event-slice.ts)
 *
 * handleEngineEvent is retired. The raw IPC.ENGINE_EVENT subscription in
 * useEngineEvents.ts was removed. Cross-cutting events (resource snapshots/
 * deltas, command lifecycle) now flow through the normalized stream and are
 * handled by handleCrossNormalizedEvent in engine-event-slice-messages.ts.
 */

export { getRendererExtensionCommands } from './engine-event-slice-helpers'

// cleanupTabDeltas is a no-op stub kept for API compatibility with tab-slice.ts
// which calls it on tab close.
export function cleanupTabDeltas(_tabId: string): void {
  // no-op: RAF delta accumulator removed, nothing to clean up
}
