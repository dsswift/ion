/**
 * The server's hop in a prompt's trace: one `prompt.handle` span per prompt a
 * client submits, from the moment the server receives it until the engine
 * accepts `send_prompt` (or the prompt is refused). It is a child of the
 * client's `prompt.send` span when the client sent a valid `traceparent`, and
 * a new root otherwise. The call to the engine is its child, an
 * `engine.send_prompt` client span, and the engine's `run.execute` server span
 * is that call's child: the call span's `traceparent` is what `send_prompt`
 * carries. A client span parenting a server span in the next service is what
 * a trace backend draws as an edge between the two.
 *
 * Span lines go through this process's logger (`server.jsonl`, or
 * `desktop.jsonl` when the server runs inside Electron main). See
 * docs/observability/log-schema.md § Spans.
 */
import {
  startSpan,
  spanLogFields,
  parseTraceparent,
  SPAN_LOG_TAG,
  type Span,
  type SpanRecord,
} from '@ion/shared/trace-context'
import { log, warn } from '../logger'

/** Writes one finished span as its span log line. */
export function writeServerSpan(record: SpanRecord): void {
  const write = record.error ? warn : log
  write(SPAN_LOG_TAG, record.name, spanLogFields(record))
}

/**
 * Which route the prompt came in on: Studio's `submit` action, a client's
 * `session.prompt` action (the phone), or a turn the server authored itself
 * (`remote`, `machine`).
 */
export type PromptSurface = 'studio' | 'session.prompt' | 'remote' | 'machine'

export interface PromptHandleArgs {
  /** The client's traceparent, as the client sent it. */
  traceparent?: string
  tabId: string
  requestId: string
  surface: PromptSurface
  conversationId?: string | null
}

/**
 * Starts `prompt.handle` for one received prompt and logs whether it joined
 * the client's trace or started a new root, and why.
 */
export function startPromptHandleSpan(args: PromptHandleArgs): Span {
  const span = startSpan('prompt.handle', {
    writer: writeServerSpan,
    kind: 'server',
    parent: args.traceparent,
    attributes: {
      tab_id: args.tabId,
      request_id: args.requestId,
      surface: args.surface,
      ...(args.conversationId ? { conversation_id: args.conversationId } : {}),
    },
  })
  const fields = { trace_id: span.traceId, tab_id: args.tabId, request_id: args.requestId, surface: args.surface }
  if (span.joined) {
    log('trace', 'prompt trace joined the client trace', fields)
  } else {
    log('trace', 'prompt trace started a new root', {
      ...fields,
      reason: args.traceparent === undefined ? 'client sent no traceparent' : 'client traceparent is invalid',
    })
  }
  return span
}

/**
 * The `trace_id` field for a log line about a prompt whose traceparent is
 * known. Empty when there is none, so a caller can always spread it.
 */
export function traceFields(traceparent: string | undefined): { trace_id?: string } {
  const parsed = parseTraceparent(traceparent)
  return parsed ? { trace_id: parsed.traceId } : {}
}

/** The engine's OTLP service name: `peer.service` on a span that calls it. */
export const ENGINE_PEER_SERVICE = 'ion-engine'

/**
 * Starts `engine.send_prompt`, the server's client span for one send_prompt
 * call, as a child of `traceparent` (the prompt's `prompt.handle`). Undefined
 * when there is no valid traceparent: the engine then starts its own trace.
 */
export function startEngineCallSpan(traceparent: string | undefined, key: string): Span | undefined {
  if (!parseTraceparent(traceparent)) return undefined
  return startSpan('engine.send_prompt', {
    writer: writeServerSpan,
    kind: 'client',
    parent: traceparent,
    attributes: { 'peer.service': ENGINE_PEER_SERVICE, session_key: key },
  })
}
