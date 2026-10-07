/**
 * The renderer's span writer: every span a Studio client times ends here,
 * as one `tag=span` log line through `rendererLogger` (`desktop.jsonl` in
 * Electron, `server.jsonl` as `component=web` in a browser). See
 * docs/observability/log-schema.md § Spans.
 *
 * Two things ride beside the line. The signed-in identity, once the local
 * welcome names it, is stamped on every span as `user`; and the last few
 * render-side spans are kept in a window-local ring so the Health page can
 * show what this window has been measuring without reading the log back.
 */
import { spanLogFields, SPAN_LOG_TAG, type SpanRecord } from '@ion/shared/trace-context'
import { rInfo, rWarn } from '../rendererLogger'

/** How many finished spans the window keeps for the Health page. */
export const RECENT_SPAN_LIMIT = 24

let spanUser: string | null = null
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
  recent = [stamped, ...recent].slice(0, RECENT_SPAN_LIMIT)
  for (const listener of listeners) listener()
}

/** The most recent spans this window wrote, newest first. A stable array until the next write. */
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
  recent = []
  listeners.clear()
}
