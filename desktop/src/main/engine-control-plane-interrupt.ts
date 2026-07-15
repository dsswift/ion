import type { EngineBridge } from './engine-bridge'
import { log as _log } from './logger'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Perform the unified interrupt for a tab: abort the parent run AND reap the
 * dispatched-agent subtree. This is the main-process equivalent of the desktop
 * renderer's `interrupt` action (renderer/stores/slices/send-slice.ts), which
 * aborts the run and then calls `engineAbortAgent(tabId, '', true)` to reap
 * descendant agents.
 *
 * Folding the reap in here (rather than only into the renderer path) means a
 * cancel arriving over the desktop↔iOS wire (`desktop_cancel` →
 * `sessionPlane.cancelTab`) behaves identically to a local interrupt: without
 * it, a remote cancel only stops the orchestrator and leaves background agents
 * running. Every wire client that cancels through the session plane therefore
 * gets correct behavior at this single choke point.
 *
 * Empty `agentName` + `subtree=true` reaps every descendant. The engine no-ops
 * safely when the session has no children (engine
 * manager_plan_abort_test.go::TestAbortAgent_UnknownSessionNoPanic /
 * TestAbortAgent_UnknownAgentNoPanic), so the reap is unconditional and correct
 * for plain runs with no dispatched agents too. `abort_agent` is fire-and-forget.
 */
export function performUnifiedInterrupt(bridge: EngineBridge, tabId: string): void {
  log('unified_interrupt: sending abort', { tab_id: tabId })
  bridge.sendAbort(tabId)
  log('unified_interrupt: reaping agent subtree', { tab_id: tabId })
  bridge.sendAbortAgent(tabId, '', true)
}
