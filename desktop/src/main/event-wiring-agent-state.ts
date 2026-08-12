// event-wiring-agent-state.ts — the engine_agent_state ingest arm.
//
// Split from event-wiring.ts at the feature seam (file-size cap): everything
// the desktop does with an inbound agent roster BEFORE it is forwarded —
// the ingest size bound, the upstream mirror record, and the pipeline
// tracing — lives here. The generic iOS forward in event-wiring.ts then
// projects the (already bounded) event like any other engine event.

import { log as _log, trace as _trace } from './logger'
import { recordAgentState } from './agent-state-mirror'
import { shedAgentsMetadata } from './remote/transport-degrade'

/**
 * Main-process ingest cap for an engine_agent_state roster. Well above the
 * engine's own 4 MiB snapshot bound, so it never fires against a healthy
 * engine — it exists to keep a pre-clamp or misbehaving engine from feeding
 * an unbounded roster into the mirror and the renderer store.
 */
const AGENT_STATE_INGEST_CAP_BYTES = 6 * 1024 * 1024

/**
 * Bound, mirror, and trace an inbound engine_agent_state event.
 *
 * MUTATES the event when the roster exceeds the ingest cap: metadata is shed
 * down to the protected identity keys and `metadataOmitted` is stamped, so
 * the renderer forward and the iOS projection downstream carry the bounded
 * form — a 30.7 MB roster once reached the renderer store verbatim and
 * OOM-killed it twice.
 *
 * Recording happens BEFORE any forward. Main sees this event first, so the
 * mirror is the upstream copy; an iOS resync is answered from here rather
 * than by scraping the renderer's downstream projection back across IPC.
 */
export function ingestAgentStateEvent(key: string, event: { agents?: unknown } & Record<string, unknown>): void {
  let agents = (Array.isArray(event.agents) ? event.agents : []) as Array<{
    name: string
    status: string
    metadata?: Record<string, unknown>
  }>

  const serializedLen = JSON.stringify(agents).length
  if (serializedLen > AGENT_STATE_INGEST_CAP_BYTES) {
    agents = shedAgentsMetadata(agents)
    event.agents = agents
    event.metadataOmitted = true
    _log('main', 'agent_state ingest bound: shed oversized roster metadata', {
      key, agents: agents.length, chars: serializedLen, cap: AGENT_STATE_INGEST_CAP_BYTES,
    })
  }

  const [mirrorTabId, mirrorInstanceId] = key.split(':')
  recordAgentState(mirrorTabId, mirrorInstanceId || null, agents as never)

  // Pairs with the engine's `agent_snapshot_emitted` utils.Log line. Trace
  // level: fires on every heartbeat tick (13k+/h at INFO would dominate the
  // desktop log volume); available when transport diagnosis is needed.
  _trace('main', 'agent_state', { key, count: agents.length })
  // Trace dispatch metadata for terminal agents so we can verify
  // conversationId survives the engine→desktop pipeline.
  for (const a of agents) {
    if ((a.status === 'done' || a.status === 'error') && a.metadata?.task) {
      const meta = a.metadata
      _trace('main', 'agent_state: dispatch_agent', { name: a.name, status: a.status, conv_id: meta.conversationId ?? 'MISSING' })
    }
  }
}
