// agent-state-shed.ts -- shed payload rather than drop a roster outright.
//
// `engine_agent_state` is a complete snapshot: a consumer replaces its local
// state with the payload. So an oversized roster must not be dropped. It
// happened in production on the `desktop_*` transport -- a 36,969,872-byte
// payload exceeded the 6 MiB cap on all 1,873 attempts across 15+ hours, and
// the periodic resync that supposedly heals it IS the thing being dropped.
//
// The ingest cap in `event-wiring-agent-state.ts` sheds the unbounded part
// (metadata) and keeps the identity a consumer needs to render a row. A shed
// snapshot is a real loss of detail; it keeps the roster correct, where a
// dropped one leaves the consumer showing whatever it had before, forever.

/**
 * Metadata keys that survive shedding.
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
 * Stage-1 shed: protected keys + slim dispatches.
 *
 * Keeps the dispatch array but strips each entry to identity fields. This
 * preserves the per-dispatch roster the renderer needs for popup state and
 * breadcrumbs while shedding the bulk (task strings, model names, elapsed).
 */
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
