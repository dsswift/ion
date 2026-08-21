import type { EngineBridge } from './engine-bridge'
import type { TabEntry } from './engine-control-plane-events'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('EngineControlPlane', msg, fields) }

/**
 * Pending-card resolution. Extracted from engine-control-plane.ts to keep that
 * class file under the 600-line cap (see desktop/AGENTS.md § file-architecture).
 *
 * A pending AskUserQuestion / ExitPlanMode is retained in TWO places, and
 * releasing only one leaves the card re-appearing or permanently stuck:
 *
 *  1. The ENGINE retains the denial and re-publishes it on every status
 *     snapshot, so a re-attaching consumer learns a question is outstanding.
 *     It releases that retention only when a new prompt supersedes the question
 *     (prompt_dispatch.go) or `/clear` discards it (clear_core.go).
 *  2. The CONTROL PLANE latches `lastSurfacedProposalSig` so a heartbeat echo
 *     of an already-surfaced proposal does not re-synthesize a task_complete
 *     and resurrect a card the user already dismissed.
 *
 * A dismissal is neither a prompt nor a `/clear`, so before this existed the
 * engine kept re-offering the denial while the latch suppressed every
 * re-delivery. That made the first surface the only surface: once anything
 * dropped the renderer's copy of the card, the re-publication needed to restore
 * it was exactly what the latch discarded. A live conversation ended up showing
 * a written plan with no way to act on it, logging "skipping proposal idle,
 * already surfaced" every 30 seconds.
 *
 * Clearing the latch here is what makes keeping it safe. The latch now means
 * "this exact proposal is currently surfaced", and resolution is the event that
 * ends that state — so a genuinely re-offered proposal surfaces again, while a
 * heartbeat echo of a still-surfaced one stays deduped.
 */
export function resolvePermissionDenials(
  bridge: EngineBridge,
  tabs: Map<string, TabEntry>,
  tabId: string,
): void {
  const tab = tabs.get(tabId)
  if (!tab) {
    log('resolve_permission_denials: no such tab', { tab_id: tabId })
    return
  }
  log('resolve_permission_denials', {
    tab_id: tabId,
    had_surfaced_sig: tab.lastSurfacedProposalSig != null,
    conversation_id: tab.conversationId ?? '',
  })
  tab.lastSurfacedProposalSig = null
  bridge.sendResolvePermissionDenials(tabId)
}
