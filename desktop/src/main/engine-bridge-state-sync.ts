import type { EngineBridge } from './engine-bridge'
import { log as _log } from './logger'

function log(msg: string): void { _log('engine-bridge', msg) }

/**
 * State-reconciliation RPCs. Extracted from engine-bridge.ts to keep
 * the primary class file under the 600-line cap and to cluster the
 * Phase 2 state-management surface (reconcile_state + the new
 * query_session_status) in one place.
 *
 * Both calls are fire-and-forget. The engine emits the snapshot on
 * its normal event bus; the bridge already subscribes to that via
 * `_handleMessage`, so the result lands in the renderer's existing
 * engine_status handlers without any per-call wiring.
 */

/**
 * Asks the engine to re-emit `engine_agent_state` AND `engine_status`
 * for the given session key. Used by the post-`start_session`
 * handshake (see engine-bridge-start-session.ts) so a freshly
 * attached desktop populates its renderer for an already-running
 * session.
 */
export function sendReconcileState(bridge: EngineBridge, key: string): void {
  log(`sendReconcileState: key=${key}`)
  bridge._send({ cmd: 'reconcile_state', key })
}

/**
 * Phase 2 of the state-management overhaul. Asks the engine to emit
 * a fresh `engine_status` snapshot for the given key without paying
 * the full `reconcile_state` cost (no agent-state re-emission). The
 * engine emits the result via its normal event channel, not as the
 * RPC result — callers observe it through the existing engine_status
 * handlers in the renderer's event slices.
 *
 * Used by the snapshot poller for any engine key whose last received
 * engine_status is older than the convergence threshold, so iOS sees
 * a refreshed status within one tick even when the engine has been
 * silent (idle session, no organic transitions).
 */
export function sendQuerySessionStatus(bridge: EngineBridge, key: string): void {
  log(`sendQuerySessionStatus: key=${key}`)
  bridge._send({ cmd: 'query_session_status', key })
}
