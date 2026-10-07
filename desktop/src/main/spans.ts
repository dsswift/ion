/**
 * Spans written by the Electron main process (docs/observability/log-schema.md
 * § Spans): one `tag=span` line through `main/logger.ts` per finished span,
 * so they land in `desktop.jsonl` beside everything else this process logs.
 *
 * The launch trace lives here too. `app.launch` is the root: it starts at
 * the process's own start (the time origin, which predates any module
 * evaluation) and ends when Electron is ready. `window.ready` is its child
 * (`studio-window-manager.ts`), and the renderer's `studio.first_paint` and
 * `store.hydrate` join through the traceparent main hands the window at
 * creation (`shared/desktop-ipc.ts`, `LAUNCH_TRACEPARENT_ARG`).
 */
import { performance } from 'perf_hooks'
import { startSpan, spanLogFields, SPAN_LOG_TAG, type Span, type SpanKind, type SpanRecord, type SpanWriter } from '@ion/shared/trace-context'
import { log, warn } from './logger'

/** Writes one finished span as its span log line. */
export const writeMainSpan: SpanWriter = (record: SpanRecord): void => {
  const write = record.error ? warn : log
  write(SPAN_LOG_TAG, record.name, spanLogFields(record))
}

export interface MainSpanOptions {
  parent?: string
  kind?: SpanKind
  attributes?: Record<string, unknown>
  /** Clock override (test use). */
  now?: () => number
  /** Writer override (test use). */
  writer?: SpanWriter
  /** The span's start, when the operation began before this call. */
  startMs?: number
}

/** A span starting now, written through this process's logger. */
export function startMainSpan(name: string, opts: MainSpanOptions = {}): Span {
  return startSpan(name, { writer: opts.writer ?? writeMainSpan, parent: opts.parent, kind: opts.kind ?? 'internal', attributes: opts.attributes, now: opts.now, startMs: opts.startMs })
}

/** A span that began at `startMs`, before anyone could start it (the process start). */
export function startMainSpanAt(name: string, startMs: number, opts: MainSpanOptions = {}): Span {
  return startMainSpan(name, { ...opts, startMs })
}

/** Wall-clock milliseconds at which this process started. */
export function processStartMs(): number {
  return Math.round(performance.timeOrigin)
}

/** The launch trace: `app.launch` and the traceparent its children join. */
export interface LaunchTrace {
  /** `app.launch`'s traceparent, for `window.ready` and the renderer's boot spans. */
  readonly traceparent: string
  /** Electron is ready. Idempotent; returns the record on the first call. */
  endAppLaunch(extra?: Record<string, unknown>): SpanRecord | undefined
}

/** Starts the launch trace at `startMs` (the process start). */
export function createLaunchTrace(startMs: number, opts: MainSpanOptions = {}): LaunchTrace {
  const span = startMainSpanAt('app.launch', startMs, { ...opts, attributes: { process: 'main', ...(opts.attributes ?? {}) } })
  return {
    traceparent: span.traceparent,
    endAppLaunch: (extra) => span.end(extra),
  }
}

let launch: LaunchTrace | null = null

/** This process's launch trace, started on first use at the process start. */
export function launchTrace(): LaunchTrace {
  launch ??= createLaunchTrace(processStartMs())
  return launch
}

/** TEST ONLY. */
export function _resetLaunchTraceForTest(): void {
  launch = null
}
