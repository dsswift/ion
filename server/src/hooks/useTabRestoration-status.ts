/**
 * Pure restore-time status helper, kept side-effect-free (no store / window
 * imports) so it is unit-testable without the browser/DOM environment the
 * useTabRestoration hooks pull in via sessionStore.
 */

/**
 * Resolve the resting status for a restored conversation from its restored
 * instance. Never 'connecting': a restored tab has no in-flight run, so it must
 * rest at 'completed' (a pending card — an AskUserQuestion / ExitPlanMode denial
 * or a non-empty permission queue — so the card renders and the user can
 * respond) or 'idle' otherwise.
 *
 * This overrides the 'connecting' that createConversationTab sets for the
 * new-tab connecting indicator. On restore there is no transition out of
 * 'connecting' (the engine session start is a warmup reconnect that goes
 * straight to idle, and the control plane suppresses that idle because its
 * TabEntry is already idle, so no task_complete is synthesized to clear the
 * renderer). Without this override the restored tab is stranded showing the
 * orange indicator + interrupt button and cannot accept input.
 *
 * Mirrors the live status the control plane assigns on task_complete with
 * denials (engine-control-plane-events.ts) and the event-slice task_complete
 * branch.
 */
export function restoredConversationStatus(
  inst: { permissionDenied?: { tools?: unknown[] } | null; permissionQueue?: unknown[] } | null | undefined,
): 'idle' | 'completed' {
  if (!inst) return 'idle'
  const hasPendingCard =
    (inst.permissionDenied?.tools?.length ?? 0) > 0 ||
    (inst.permissionQueue?.length ?? 0) > 0
  return hasPendingCard ? 'completed' : 'idle'
}
