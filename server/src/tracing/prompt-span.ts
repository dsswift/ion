/**
 * The server's hop in a prompt's trace. A prompt a client submits arrives as
 * a Studio action (`submit`, `submitRemotePrompt`, `session.prompt`), so its
 * server span is the `action.handle` span `protocol/actions.ts` opened for
 * that action: the prompt path annotates it (tab, request, outcome) and never
 * opens a second one. A prompt the server authors itself (a `machine` or
 * `remote` turn with no action in flight) opens `action.handle` with
 * `action=submit` here, as a child of the caller's span when it sent a valid
 * `traceparent` and a new root otherwise.
 *
 * The call into the engine is the span's child, an `engine.send_prompt`
 * client span, and the engine's `run.execute` server span is that call's
 * child: the call span's `traceparent` is what `send_prompt` carries. A
 * client span parenting a server span in the next service is what a trace
 * backend draws as an edge between the two.
 *
 * Span lines go through this process's logger (`server.jsonl`, or
 * `desktop.jsonl` when the server runs inside Electron main). See
 * docs/observability/log-schema.md § Spans.
 */
import { parseTraceparent, type Span } from '@ion/shared/trace-context'
import { log } from '../logger'
import { annotateSpan, currentSpan, ENGINE_PEER_SERVICE, failSpan, startServerSpan } from './op-span'

export { writeServerSpan, ENGINE_PEER_SERVICE } from './op-span'

/**
 * Which route the prompt came in on: Studio's `submit` action, a client's
 * `session.prompt` action (the phone), or a turn the server authored itself
 * (`remote`, `machine`). The span attribute `prompt_surface`.
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
 * The prompt's server span. Inside an action, the ambient `action.handle`
 * span is annotated and returned as a view whose `end()` records the
 * outcome on it without ending it (the action ends it when its result is
 * sent). Outside one, a new `action.handle` with `action=submit` is started,
 * and one line says whether it joined the caller's trace or started a root.
 */
export function startPromptHandleSpan(args: PromptHandleArgs): Span {
  const promptAttrs = {
    tab_id: args.tabId,
    request_id: args.requestId,
    prompt_surface: args.surface,
    ...(args.conversationId ? { conversation_id: args.conversationId } : {}),
  }
  const ambient = currentSpan()
  if (ambient) {
    annotateSpan(promptAttrs)
    return {
      traceId: ambient.traceId,
      spanId: ambient.spanId,
      parentSpanId: ambient.parentSpanId,
      traceparent: ambient.traceparent,
      joined: ambient.joined,
      end(extraAttributes, error) {
        if (extraAttributes) annotateSpan(extraAttributes)
        if (error) failSpan(error)
        return undefined
      },
    }
  }
  const span = startServerSpan('action.handle', {
    kind: 'server',
    parent: args.traceparent,
    root: args.traceparent === undefined,
    attrs: { action: 'submit', surface: 'server', ...promptAttrs },
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

/**
 * Starts `engine.send_prompt`, the server's client span for one send_prompt
 * call, as a child of `traceparent` (the prompt's `action.handle`). Undefined
 * when there is no valid traceparent: the engine then starts its own trace.
 */
export function startEngineCallSpan(traceparent: string | undefined, key: string): Span | undefined {
  if (!parseTraceparent(traceparent)) return undefined
  return startServerSpan('engine.send_prompt', {
    kind: 'client',
    parent: traceparent,
    attrs: { 'peer.service': ENGINE_PEER_SERVICE, session_key: key },
  })
}
