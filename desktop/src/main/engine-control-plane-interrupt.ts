import type { EngineBridge } from './engine-bridge'
import type { AbortScope } from '../shared/types-engine'
import { log as _log } from './logger'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Perform the interrupt for a tab at the requested scope. This is the
 * main-process equivalent of the renderer's `interrupt` action
 * (renderer/stores/slices/send-slice.ts), and the single choke point every
 * wire client's cancel passes through, so a `desktop_cancel` arriving from iOS
 * behaves identically to a local Stop.
 *
 * `all` tears down the run and dispatch tree but preserves detached shell work;
 * `all_work` adds every session-owned background Bash task. `orchestrator`
 * cancels only the active run. The scope rides the engine's `abort` command — see engine/internal/session/abort_scope.go for the
 * authoritative semantics.
 *
 */
export function performUnifiedInterrupt(
  bridge: EngineBridge,
  tabId: string,
  scope: AbortScope = 'all',
): void {
  log('unified_interrupt: sending abort', { tab_id: tabId, abort_scope: scope })
  bridge.sendAbort(tabId, scope)
  if (scope === 'orchestrator') {
    log('unified_interrupt: leaving dispatches running (orchestrator scope)', { tab_id: tabId })
    return
  }
}

/**
 * Stop ONE background dispatch, leaving the orchestrator and every sibling
 * dispatch running. Addressed by the collision-safe dispatch ID the engine
 * surfaces as `dispatchId` on each `engine_agent_state` dispatch member, so it
 * targets a specific instance even when several dispatches share an agent name.
 *
 * Lives beside performUnifiedInterrupt (rather than as a control-plane method)
 * because it is the same kind of stateless bridge call, and engine-control-plane.ts
 * is at its file-size cap.
 */
export function performDispatchAbort(bridge: EngineBridge, tabId: string, dispatchId: string): void {
  log('dispatch_abort: sending', { tab_id: tabId, dispatch_id: dispatchId })
  bridge.sendAbortDispatch(tabId, dispatchId)
}
