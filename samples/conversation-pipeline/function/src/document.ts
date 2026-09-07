// The hot document shape and the two derivations the stores agree on:
// the document identity (event_id, or event_id:part for a segment) and the
// sort key (nanosecond timestamp, then seq). Both mirror
// internal/stream/event.go in the Go tooling; the contract they implement
// is docs/observability/conversation-events.schema.json.

export interface SegmentBlock {
  part: number
  parts: number
  field: string
  total_bytes: number
  sha256: string
}

export interface StreamEnvelope {
  name: string
  ts: string
  schema: number
  component: string
  install_id?: string
  host?: string
  version?: string
  event_id: string
  user?: string
  trace_id: string
  parent_span_id: string
  context?: Record<string, unknown>
  payload: Record<string, unknown> & { conversation_id?: string; seq?: number; segment?: SegmentBlock }
}

export interface HotDocument {
  id: string
  conversation_id: string
  name: string
  ts: string
  sort_key: string
  seq: number
  part?: number
  parts?: number
  user?: string
  event: StreamEnvelope
  ingested_at: string
  ttl?: number
}

/** event_id alone, or event_id:part for one part of a segmented event. */
export function documentId(e: StreamEnvelope): string {
  const seg = e.payload.segment
  return seg && typeof seg.part === 'number' ? `${e.event_id}:${seg.part}` : e.event_id
}

/**
 * Nanoseconds since the epoch as 19 zero-padded digits, then the seq as 12,
 * so (ts, seq) order is plain string order. JavaScript dates carry only
 * milliseconds, so the fraction is taken from the RFC 3339 text directly.
 */
export function sortKey(ts: string, seq: number): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts)
  if (!match) throw new Error(`ts is not RFC 3339: ${ts}`)
  const [, whole, fraction = '', zone] = match
  const seconds = BigInt(Math.floor(Date.parse(`${whole}${zone}`) / 1000))
  const nanos = seconds * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))
  return `${nanos.toString().padStart(19, '0')}-${String(seq).padStart(12, '0')}`
}

export function toHotDocument(e: StreamEnvelope, ingestedAt: string, ttlSeconds: number): HotDocument {
  const seq = typeof e.payload.seq === 'number' ? e.payload.seq : 0
  const seg = e.payload.segment
  return {
    id: documentId(e),
    conversation_id: e.payload.conversation_id as string,
    name: e.name,
    ts: e.ts,
    sort_key: sortKey(e.ts, seq),
    seq,
    ...(seg ? { part: seg.part, parts: seg.parts } : {}),
    ...(e.user ? { user: e.user } : {}),
    event: e,
    ingested_at: ingestedAt,
    ...(ttlSeconds > 0 ? { ttl: ttlSeconds } : {}),
  }
}
