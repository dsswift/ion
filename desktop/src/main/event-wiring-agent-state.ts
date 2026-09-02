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

  // Nesting attribution, on the RECEIVE side.
  //
  // `dispatchParentId` is the only field the renderer groups children by
  // (agent-helpers.ts childAgentsOf), and nothing on this side ever logged it.
  // Combined with the engine logging only a count, a report of "the dispatch
  // drill-down shows no child agents" could not be attributed to a layer: the
  // engine's emission and the desktop's ingest were both opaque. This pairs
  // with the engine's `agent snapshot nesting summary` so the two can be
  // compared directly for the same snapshot.
  //
  // A nested agent (depth > 1) that arrives with no parent id cannot be
  // grouped under anything, so the renderer shows it at the root. That is a
  // real rendering defect rather than a cosmetic one, so it warns.
  let nested = 0
  let missingAttribution = 0
  for (const a of agents) {
    const parentId = typeof a.metadata?.dispatchParentId === 'string' ? a.metadata.dispatchParentId : ''
    const rawDepth = a.metadata?.dispatchDepth
    const depth = typeof rawDepth === 'number' ? rawDepth : null
    if (parentId) nested++
    else if (depth !== null && depth > 1) missingAttribution++
  }
  if (missingAttribution > 0) {
    _log('main', 'agent_state: nested agents arrived with no parent attribution; they will render at root', {
      key, count: agents.length, nested, missingAttribution,
    })
  } else {
    _trace('main', 'agent_state: nesting', { key, count: agents.length, nested, missingAttribution })
  }
}
