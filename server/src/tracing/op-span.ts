/**
 * op-span -- one span per server operation, and the trace that is ambient
 * while it runs.
 *
 * `withSpan` times one operation as a span (`startSpan` from
 * `@ion/shared/trace-context`), writes it through this process's logger when
 * it ends (`writeServerSpan`), and makes it the ambient span for everything
 * the operation does: a span started inside it becomes its child without a
 * threaded parameter, the same way `identity/request-principal.ts` carries
 * the caller. The engine bridge reads the ambient span to parent
 * `engine.request`; the sealed socket reads it to put `traceparent` on the
 * envelope it sends; the Studio event fan-out runs under the engine event's
 * trace (`runWithTrace`) so every frame it writes names that trace.
 *
 * Every span carries `user`, the principal the operation runs for, so span
 * metrics slice by person. See docs/observability/log-schema.md § Spans.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  formatTraceparent,
  parseTraceparent,
  spanLogFields,
  startSpan,
  SPAN_LOG_TAG,
  type Span,
  type SpanKind,
  type SpanRecord,
  type TraceParent,
} from '@ion/shared/trace-context'
import { log, warn } from '../logger'
import { currentPrincipal } from '../identity/request-principal'

/** Writes one finished span as its span log line. A failed span is WARN. */
export function writeServerSpan(record: SpanRecord): void {
  const write = record.error ? warn : log
  write(SPAN_LOG_TAG, record.name, spanLogFields(record))
}

/** The engine's OTLP service name: `peer.service` on a span that calls it. */
export const ENGINE_PEER_SERVICE = 'ion-engine'

/** What is ambient while an operation runs: its span, or only a trace to carry. */
interface ActiveTrace {
  span?: Span
  trace: TraceParent
  /** The trace `runWithTrace` carried in (an engine event's), kept through the spans nested inside it. */
  carried?: TraceParent
  /** Attributes added while the span runs (`annotateSpan`), merged in at its end. */
  extra: Record<string, unknown>
  /** Set by `failSpan`: the span ends failed with this message. */
  error?: string
}

const storage = new AsyncLocalStorage<ActiveTrace>()

/** The span the calling operation runs under, or undefined outside one. */
export function currentSpan(): Span | undefined {
  return storage.getStore()?.span
}

/** The trace the calling operation runs under: its span's, or one carried by `runWithTrace`. */
export function currentTrace(): TraceParent | undefined {
  return storage.getStore()?.trace
}

/**
 * The trace an enclosing `runWithTrace` carried in (an engine event's), even
 * from inside a span nested in it. What a frame derived from an engine event
 * is stamped with; undefined when no event is being handled, whatever spans
 * are open.
 */
export function currentEventTrace(): TraceParent | undefined {
  return storage.getStore()?.carried
}

/** The ambient trace as a `traceparent` value, for an outbound hop. */
export function currentTraceparent(): string | undefined {
  const trace = currentTrace()
  return trace ? formatTraceparent(trace.traceId, trace.spanId) : undefined
}

/** Adds attributes to the ambient span. A no-op outside one. */
export function annotateSpan(attributes: Record<string, unknown>): void {
  const active = storage.getStore()
  if (!active?.span) return
  Object.assign(active.extra, attributes)
}

/** Marks the ambient span failed; it ends with `error`. A no-op outside one. */
export function failSpan(error: string): void {
  const active = storage.getStore()
  if (!active?.span) return
  active.error = error
}

/**
 * Runs `fn` under `trace` (ids or a `traceparent`) without starting a span:
 * what the engine event fan-out does, so every frame and envelope written
 * while an engine event is handled names that event's trace. An invalid or
 * absent trace leaves the ambient context as it was.
 */
export function runWithTrace<T>(trace: TraceParent | string | undefined | null, fn: () => T): T {
  const resolved = typeof trace === 'string' ? parseTraceparent(trace) : trace ?? null
  if (!resolved || !parseTraceparent(formatTraceparent(resolved.traceId, resolved.spanId))) return fn()
  return storage.run({ trace: resolved, carried: resolved, extra: {} }, fn)
}

/** The `user` attribute every server span carries: the principal the operation runs for. */
export function userAttribute(): { user?: string } {
  const subject = currentPrincipal()?.subject
  return subject ? { user: subject } : {}
}

export interface SpanOptions {
  kind?: SpanKind
  attrs?: Record<string, unknown>
  /**
   * The parent, as ids or a `traceparent`. Defaults to the ambient span (or
   * ambient trace); `root: true` starts a new trace whatever is ambient.
   */
  parent?: TraceParent | string
  root?: boolean
  /** Clock override (test use). */
  now?: () => number
  /** The span's start when the operation began before this call (see `StartSpanOptions.startMs`). */
  startMs?: number
}

/**
 * Starts a server span without running anything under it. For an operation
 * whose end is not a function return (the process start-up, a request whose
 * answer arrives on another callback). `end()` writes the span line.
 */
export function startServerSpan(name: string, opts: SpanOptions = {}): Span {
  const ambient = storage.getStore()
  const parent = opts.root ? undefined : (opts.parent ?? ambient?.span?.traceparent ?? ambient?.trace)
  return startSpan(name, {
    writer: writeServerSpan,
    kind: opts.kind,
    parent,
    now: opts.now,
    startMs: opts.startMs,
    attributes: { ...userAttribute(), ...(opts.attrs ?? {}) },
  })
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as Promise<unknown>).then === 'function'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The running span's handle, bound to it rather than to the ambient context:
 * for a callback that fires outside the operation's async chain (a response's
 * `finish` event) and still describes this span.
 */
export interface SpanContext {
  annotate(attributes: Record<string, unknown>): void
  fail(error: string): void
}

/**
 * Runs `fn` as one span. Synchronous or asynchronous: a returned promise ends
 * the span when it settles; anything else ends it when `fn` returns. A throw
 * or rejection ends the span failed with the error's message and is
 * rethrown. The span is ambient inside `fn`.
 */
export function withSpan<T>(name: string, opts: SpanOptions, fn: (span: Span, ctx: SpanContext) => T): T {
  const span = startServerSpan(name, opts)
  const active: ActiveTrace = { span, trace: { traceId: span.traceId, spanId: span.spanId }, carried: storage.getStore()?.carried, extra: {} }
  const ctx: SpanContext = {
    annotate: (attributes) => { Object.assign(active.extra, attributes) },
    fail: (error) => { active.error = error },
  }
  const finish = (error?: string): void => {
    span.end(active.extra, error ?? active.error)
  }
  let result: T
  try {
    result = storage.run(active, () => fn(span, ctx))
  } catch (err) {
    finish(errorMessage(err))
    throw err
  }
  if (isPromise(result)) {
    return result.then(
      (value) => {
        finish()
        return value
      },
      (err: unknown) => {
        finish(errorMessage(err))
        throw err
      },
    ) as T
  }
  finish()
  return result
}
