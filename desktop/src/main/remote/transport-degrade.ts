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

/**
 * Identity fields kept in slim dispatch entries during stage-1 degradation.
 * These are what the renderer needs to render a dispatch row and key popup
 * state; the heavier fields (task, model) are shed.
 */
const SLIM_DISPATCH_KEYS = ['id', 'status', 'conversationId', 'startTime'] as const

/**
 * Reduce each dispatch entry to identity-only fields.
 */
function slimDispatch(d: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {}
  for (const key of SLIM_DISPATCH_KEYS) {
    if (key in d) slim[key] = d[key]
  }
  return slim
}

/**
 * Stage-1 shed: protected keys + slim dispatches.
 *
 * Keeps the dispatch array but strips each entry to identity fields. This
 * preserves the per-dispatch roster the renderer needs for popup state and
 * breadcrumbs while shedding the bulk (task strings, model names, elapsed).
 */
function shedAgentsMetadataSlim<T extends { metadata?: Record<string, unknown> }>(agents: T[]): T[] {
  return agents.map((a) => {
    const metadata: Record<string, unknown> = {}
    for (const key of PROTECTED_AGENT_METADATA_KEYS) {
      if (a.metadata && key in a.metadata) metadata[key] = a.metadata[key]
    }
    if (a.metadata && Array.isArray(a.metadata.dispatches)) {
      metadata.dispatches = (a.metadata.dispatches as Record<string, unknown>[]).map(slimDispatch)
    }
    return { ...a, metadata }
  })
}

/**
 * Stage-2 shed: protected keys only, no dispatches.
 *
 * Exported for the main-process ingest bound (event-wiring): the same shed
 * applied there keeps an oversized roster from a misbehaving or pre-clamp
 * engine out of the mirror and the renderer store entirely, instead of only
 * out of the iOS wire.
 */
export function shedAgentsMetadata<T extends { metadata?: Record<string, unknown> }>(agents: T[]): T[] {
  return agents.map((a) => {
    const metadata: Record<string, unknown> = {}
    for (const key of PROTECTED_AGENT_METADATA_KEYS) {
      if (a.metadata && key in a.metadata) metadata[key] = a.metadata[key]
    }
    return { ...a, metadata }
  })
}

type AgentStatePayload = RemoteEvent & {
  type: 'desktop_agent_state'
  agents?: Array<{ name: string; status: string; id?: string; metadata?: Record<string, unknown> }>
}

/**
 * Two-stage degradation for desktop_agent_state:
 *
 * Stage 1 — shed large metadata values but keep slim dispatches (identity
 * fields only). This preserves the per-dispatch roster the renderer needs.
 *
 * Stage 2 — strip ALL metadata to protected keys only (no dispatches).
 * Fallback when stage 1 still exceeds the cap.
 *
 * Returns the degraded event with metadataOmitted stamped, or null if even
 * stage 2 cannot fit.
 */
type DegradedCandidate = { event: RemoteEvent; plaintext: string }

function shedAgentMetadata(event: RemoteEvent, cap: number): DegradedCandidate | null {
  const e = event as AgentStatePayload
  if (!Array.isArray(e.agents)) return null

  const stage1 = { ...e, agents: shedAgentsMetadataSlim(e.agents), metadataOmitted: true } as RemoteEvent
  const stage1Plaintext = JSON.stringify(stage1)
  if (stage1Plaintext.length <= cap) return { event: stage1, plaintext: stage1Plaintext }

  const stage2 = { ...e, agents: shedAgentsMetadata(e.agents), metadataOmitted: true } as RemoteEvent
  const stage2Plaintext = JSON.stringify(stage2)
  if (stage2Plaintext.length > cap) return null
  return { event: stage2, plaintext: stage2Plaintext }
}

/**
 * Degraders by event type. An event type absent here cannot be degraded and
 * is dropped when oversized, as before.
 */
export const DEGRADERS: Map<string, (event: RemoteEvent, cap: number) => DegradedCandidate | null> = new Map([
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

  return degrader(event, cap)
}
