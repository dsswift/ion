/**
 * Dialog-response seam of `EngineControlPlane`: the two answers a human gives
 * back to a waiting run — a permission decision and an elicitation reply.
 *
 * Extracted from engine-control-plane.ts to keep it under the 600-line
 * TypeScript cap. They belong together and apart from the rest: both are
 * inbound answers rather than lifecycle or dispatch, both refuse an unknown tab
 * the same way, and the permission path owns the cross-surface reconcile that
 * is the only reason the control plane knows about the Studio window at all.
 * Isolating that here keeps the studio dependency off the main class file.
 */
import { log as _log } from './logger'
import type { EngineBridge } from './engine-bridge'
import type { TabEntry } from './engine-control-plane-events'
import { resolveStudioPermission } from './studio-state-cache'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Deliver a permission answer and reconcile every other surface showing it.
 *
 * `onResolved` is called after the answer is sent, with the tab and question
 * ids. The control plane emits its `permission-resolved` event from there
 * rather than this module importing the studio window manager directly:
 * engine-control-plane → studio-window-manager → state → engine-control-plane
 * is a module cycle that only loads by import-order luck.
 *
 * Returns false for an unknown tab, logging the drop — an answer that reaches
 * no session must not look the same as one that was delivered.
 */
export function respondToPermission(
  tabs: Map<string, TabEntry>,
  bridge: EngineBridge,
  tabId: string,
  questionId: string,
  optionId: string,
  onResolved: (tabId: string, questionId: string) => void,
): boolean {
  if (!tabs.has(tabId)) {
    log('respond_to_permission: dropped, unknown tab', { tab_id: tabId, question_id: questionId })
    return false
  }
  bridge.sendPermissionResponse(tabId, questionId, optionId)
  // Cross-surface reconcile (mirror-store architecture): this is the ONE spot
  // every surface's answer funnels through — overlay card, iOS remote, Studio
  // approval. Resolving the Studio window pending queue and pushing the
  // resolution here means an answer from ANY surface clears the others
  // instantly, instead of waiting for the next status transition.
  resolveStudioPermission(tabId, questionId)
  onResolved(tabId, questionId)
  return true
}

/** Deliver an elicitation reply. Returns false for an unknown tab. */
export function respondToElicitation(
  tabs: Map<string, TabEntry>,
  bridge: EngineBridge,
  tabId: string,
  requestId: string,
  response: Record<string, unknown> | undefined,
  cancelled: boolean,
  declined: boolean,
): boolean {
  if (!tabs.has(tabId)) {
    log('respond_to_elicitation: dropped, unknown tab', { tab_id: tabId, request_id: requestId, cancelled })
    return false
  }
  bridge.sendElicitationResponse(tabId, requestId, response, cancelled, declined)
  return true
}
