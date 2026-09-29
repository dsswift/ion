// agent-state.ts — read the current agent roster from the main-process mirror.
//
// The engine sends `engine_agent_state` as a COMPLETE snapshot, and this
// module keeps the answer to "what is live on this tab right now" in one
// place, so every wire that asks gets the same roster rather than each one
// scraping it from somewhere different.
//
// The self-heal that used to live here — a delayed re-send after a dropped
// or degraded oversized payload — was a delivery retry for the device
// transport, which is gone. An oversized roster is now handled where it is
// ingested, by shedding payload rather than dropping the snapshot
// (`engine/agent-state-shed.ts`), so there is nothing left to retry.

import { log as _log } from '../../logger'
import { getAgentState, hasAgentState, getKnownInstanceId } from '../../engine/agent-state-mirror'

function log(msg: string, fields?: Record<string, unknown>): void { _log('RemoteAgentState', msg, fields) }

/**
 * The current agent roster for a tab, from the main-process mirror. One read
 * for every caller: the `engine.agentState` Studio action, and the roster a
 * first paint carries.
 *
 * An unknown tab still gets an answer. Under the complete-snapshot contract
 * an empty roster is the authoritative "no agents are live" signal, so
 * staying silent would leave the client rendering rows the server no longer
 * knows about -- the exact failure the request was sent to resolve.
 */
export function readAgentRoster(tabId: string, requestedInstanceId: string | null | undefined, requester: string): { tabId: string; instanceId: string | null; agents: ReturnType<typeof getAgentState> } {
  const instanceId = requestedInstanceId ?? getKnownInstanceId(tabId)
  const known = hasAgentState(tabId, instanceId)
  const agents = getAgentState(tabId, instanceId)
  log('request_agent_state: serving from mirror', { tab_id: tabId, instance_id: instanceId, requester, agents: agents.length, known })
  return { tabId, instanceId, agents }
}
