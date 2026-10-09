/**
 * The renderer's span writer: every span a Studio client times ends here,
 * as one `tag=span` log line through `rendererLogger` (`desktop.jsonl` in
 * Electron, `server.jsonl` as `component=web` in a browser). See
 * docs/observability/log-schema.md § Spans.
 *
 * Two things ride beside the line. The signed-in identity, once the local
 * welcome names it, is stamped on every span as `user`; and the last few
 * render-side spans are kept in a window-local ring per span name, so the
 * Health page can show what this window has been measuring without reading
 * the log back. Per name, because one busy span (`transcript.apply` while a
 * conversation streams) would otherwise push the one-off spans
 * (`studio.first_paint`, `store.hydrate`) out within minutes.
 */
import { spanLogFields, SPAN_LOG_TAG, type SpanRecord } from '@ion/shared/trace-context'
import { rInfo, rWarn } from '../rendererLogger'

/** How many finished spans of each name the window keeps for the Health page. */
export const RECENT_SPANS_PER_NAME = 6

interface Kept { seq: number; record: SpanRecord }

let spanUser: string | null = null
let seq = 0
const byName = new Map<string, Kept[]>()
let recent: SpanRecord[] = []
const listeners = new Set<() => void>()

/** The identity every later span carries as `user`; null clears it. */
export function setSpanUser(user: string | null): void {
  spanUser = user && user !== '' ? user : null
}

/** Writes one finished span as its span log line, and remembers it for the Health page. */
export function writeRendererSpan(record: SpanRecord): void {
  const stamped: SpanRecord = spanUser && record.attributes.user === undefined
    ? { ...record, attributes: { ...record.attributes, user: spanUser } }
    : record
  const write = stamped.error ? rWarn : rInfo
  write(SPAN_LOG_TAG, stamped.name, spanLogFields(stamped))
  byName.set(stamped.name, [{ seq: seq++, record: stamped }, ...(byName.get(stamped.name) ?? [])].slice(0, RECENT_SPANS_PER_NAME))
  recent = [...byName.values()].flat().sort((a, b) => b.seq - a.seq).map((k) => k.record)
  for (const listener of listeners) listener()
}

/** The most recent spans of each name this window wrote, newest first. A stable array until the next write. */
export function recentRendererSpans(): readonly SpanRecord[] {
  return recent
}

/** Notifies on every write. Returns the unsubscribe. */
export function subscribeRendererSpans(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** TEST ONLY. */
export function _resetSpanWriterForTest(): void {
  spanUser = null
  seq = 0
  byName.clear()
  recent = []
  listeners.clear()
}
