/**
 * The client end of a prompt's trace for Studio, in Electron and in a browser.
 *
 * A prompt's trace starts here, the moment the operator submits: a
 * `prompt.send` span (kind client) whose `traceparent` rides the `submit`
 * action to the server, where `prompt.handle` joins it as a child. The span
 * ends when the server answers the action, accepted or refused.
 *
 * Span lines go through `rendererLogger`, so they land in `desktop.jsonl`
 * (Electron) or `server.jsonl` as `component=web` (browser, via `POST /log`).
 * See docs/observability/log-schema.md § Spans.
 */
import { startSpan, spanLogFields, SPAN_LOG_TAG, type SpanRecord } from '@ion/shared/trace-context'
import type { PromptSubmitResult } from '@ion/shared/prompt-submit-result'
import { rInfo, rWarn } from '../rendererLogger'
import { host } from '../host/host-instance'

/** Writes one finished span as its span log line. */
export function writeRendererSpan(record: SpanRecord): void {
  const write = record.error ? rWarn : rInfo
  write(SPAN_LOG_TAG, record.name, spanLogFields(record))
}

/** Which Studio client this renderer is: only the desktop host has an operating-system shell. */
export function rendererSurface(): 'studio-desktop' | 'studio-web' {
  return host.capabilities().includes('nativeShell') ? 'studio-desktop' : 'studio-web'
}

type SubmitOutcome = PromptSubmitResult | Promise<PromptSubmitResult> | void

/** The store's `submit`, narrowed to what a traced send passes. */
export type TracedSubmit = (tabId: string, text: string, opts: { traceparent: string }) => SubmitOutcome

/**
 * Submits `text` under a new `prompt.send` span and returns `submit`'s own
 * outcome unchanged, so a caller that reads the result (the composer's
 * restore-on-refusal) behaves exactly as before.
 */
export function submitWithTrace(
  submit: TracedSubmit,
  tabId: string,
  text: string,
  conversationId?: string | null,
): SubmitOutcome {
  const span = startSpan('prompt.send', {
    writer: writeRendererSpan,
    kind: 'client',
    attributes: {
      // The callee, so a trace backend names the dependency's target.
      'peer.service': 'ion-server',
      tab_id: tabId,
      surface: rendererSurface(),
      ...(conversationId ? { conversation_id: conversationId } : {}),
    },
  })
  let outcome: SubmitOutcome
  try {
    outcome = submit(tabId, text, { traceparent: span.traceparent })
  } catch (err) {
    span.end(undefined, err instanceof Error ? err.message : String(err))
    throw err
  }
  if (outcome && typeof (outcome as Promise<PromptSubmitResult>).then === 'function') {
    void (outcome as Promise<PromptSubmitResult>).then(
      (result) => endWithResult(span.end, result),
      // The caller handles the rejection itself; this branch only closes the span.
      (err: unknown) => { span.end(undefined, err instanceof Error ? err.message : String(err)) },
    )
  } else {
    endWithResult(span.end, outcome as PromptSubmitResult | void)
  }
  return outcome
}

function endWithResult(
  end: (extra?: Record<string, unknown>, error?: string) => unknown,
  result: PromptSubmitResult | void,
): void {
  if (!result || result.accepted) {
    end({ accepted: true })
    return
  }
  end({ accepted: false, reason: result.reason }, `prompt refused: ${result.reason}`)
}
