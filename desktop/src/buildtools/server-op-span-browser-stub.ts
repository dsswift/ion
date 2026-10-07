/**
 * server-op-span-browser-stub — the Studio renderer's build-time replacement
 * for `server/src/tracing/op-span.ts`.
 *
 * The real file keeps the ambient span of a server operation in an
 * `AsyncLocalStorage` (`node:async_hooks`), which no renderer has, and is
 * reachable from the session store's reactive selectors through the
 * transcript publisher, the thin-view sync, and the protocol modules. Server
 * spans are the server's: the mirror store running a reducer in this window
 * is not the operation the server timed, so nothing here writes a span.
 * `withSpan` runs its function, the ambient readers answer "no trace", and
 * `startServerSpan` hands back a span whose `end()` is a no-op write.
 * Wired in via `renderer-server-stubs.ts`, keyed on op-span.ts's resolved path.
 */
import { startSpan, type Span, type SpanKind, type TraceParent } from '@ion/shared/trace-context'

export const ENGINE_PEER_SERVICE = 'ion-engine'

export function writeServerSpan(): void {
  // The server writes its own spans; a renderer never does.
}

export function currentSpan(): Span | undefined {
  return undefined
}

export function currentTrace(): TraceParent | undefined {
  return undefined
}

export function currentEventTrace(): TraceParent | undefined {
  return undefined
}

export function currentTraceparent(): string | undefined {
  return undefined
}

export function annotateSpan(_attributes: Record<string, unknown>): void {
  // No ambient span in a renderer.
}

export function failSpan(_error: string): void {
  // No ambient span in a renderer.
}

export function runWithTrace<T>(_trace: TraceParent | string | undefined | null, fn: () => T): T {
  return fn()
}

export function userAttribute(): { user?: string } {
  return {}
}

export interface SpanOptions {
  kind?: SpanKind
  attrs?: Record<string, unknown>
  parent?: TraceParent | string
  root?: boolean
  now?: () => number
  startMs?: number
}

export interface SpanContext {
  annotate(attributes: Record<string, unknown>): void
  fail(error: string): void
}

/** A span handle with the real ids and a write that goes nowhere. */
export function startServerSpan(name: string, opts: SpanOptions = {}): Span {
  return startSpan(name, { writer: writeServerSpan, kind: opts.kind, parent: opts.root ? undefined : opts.parent, now: opts.now, startMs: opts.startMs, attributes: opts.attrs })
}

export function withSpan<T>(name: string, opts: SpanOptions, fn: (span: Span, ctx: SpanContext) => T): T {
  const span = startServerSpan(name, opts)
  const ctx: SpanContext = { annotate: () => undefined, fail: () => undefined }
  return fn(span, ctx)
}
