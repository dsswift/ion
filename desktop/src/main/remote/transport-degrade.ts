// transport-degrade.ts — shed payload rather than drop a frame outright.
//
// The transport has two size gates: a plaintext cap before compression and a
// wire-frame cap after. Both used to drop the event entirely.
//
// For desktop_agent_state that was the wrong failure mode, and it happened in
// production: a 36,969,872-byte payload exceeded the 6 MiB plaintext cap on
// all 1,873 attempts across 15+ hours. Every one was dropped, so the phone
// went blind to agent state for the whole window. There was no recovery path,
// because the periodic resync that supposedly heals it IS the thing being
// dropped.
//
// It also contradicted the transport's own contract: desktop_agent_state is in
// CRITICAL_TYPES, documented as "must never be silently dropped", and the size
// gate dropped it anyway.
//
// So a degrader sheds the unbounded part (metadata) and ships the identity a
// consumer needs to render a row. A degraded snapshot is a real loss of
// detail, but it keeps the roster correct; a dropped one leaves the consumer
// showing whatever it had before, indefinitely.

import type { RemoteEvent } from './protocol'

/**
 * Metadata keys that survive degradation.
 *
 * This set is not "the fields that seemed important" — each entry is here
 * because a specific consumer breaks without it:
 *
 * - `displayName` is the row's label; without it every agent renders blank.
 *   The engine's own agent-state validator also treats a missing displayName
 *   as a malformed payload.
 * - `visibility` and `invited` decide whether a row renders AT ALL on iOS.
 *   Its decoder defaults an absent `visibility` to "ephemeral", and ephemeral
 *   agents are shown only while running; an absent `invited` defaults to
 *   false, which hides "sticky" rows. Shedding either turns a degraded
 *   payload into a silently empty agents panel — a wrong-but-successful
 *   render, which is worse than the drop this replaces.
 * - `type` drives grouping, and the dispatch keys carry per-dispatch identity
 *   that popup and breadcrumb state is keyed on.
 */
const PROTECTED_AGENT_METADATA_KEYS = [
  'displayName',
  'type',
  'visibility',
  'invited',
  'color',
  'dispatchId',
  'dispatchParentId',
  'dispatchDepth',
] as const

/** Strip agent metadata down to the protected subset. */
function shedAgentMetadata(event: RemoteEvent): RemoteEvent | null {
  const e = event as RemoteEvent & {
    type: 'desktop_agent_state'
    agents?: Array<{ name: string; status: string; id?: string; metadata?: Record<string, unknown> }>
  }
  if (!Array.isArray(e.agents)) return null

  const agents = e.agents.map((a) => {
    const metadata: Record<string, unknown> = {}
    for (const key of PROTECTED_AGENT_METADATA_KEYS) {
      if (a.metadata && key in a.metadata) metadata[key] = a.metadata[key]
    }
    return { ...a, metadata }
  })

  return { ...e, agents, metadataOmitted: true } as RemoteEvent
}

/**
 * Degraders by event type. An event type absent here cannot be degraded and
 * is dropped when oversized, as before.
 */
export const DEGRADERS: Map<string, (event: RemoteEvent) => RemoteEvent | null> = new Map([
  ['desktop_agent_state', shedAgentMetadata],
])

/** Whether a degrader exists for this event type. */
export function canDegrade(eventType: string): boolean {
  return DEGRADERS.has(eventType)
}

/**
 * Attempt to shrink an oversized event below `cap`.
 *
 * Returns the degraded event and its serialized form, or null when the type
 * has no degrader or the degraded form is still too large. The caller drops in
 * that case — degradation is a best effort, not a guarantee, and a degraded
 * payload that still overflows must not be sent.
 */
export function degradeOversizedEvent(
  event: RemoteEvent,
  cap: number,
): { event: RemoteEvent; plaintext: string } | null {
  const degrader = DEGRADERS.get(event.type)
  if (!degrader) return null

  const degraded = degrader(event)
  if (!degraded) return null

  const plaintext = JSON.stringify(degraded)
  if (plaintext.length > cap) return null

  return { event: degraded, plaintext }
}
