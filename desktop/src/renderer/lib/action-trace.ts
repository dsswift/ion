/**
 * The client end of an action's trace for Studio, in Electron and in a
 * browser.
 *
 * Every `studio_action` the renderer sends is one client span whose
 * `traceparent` rides the frame to the server, where `action.handle` joins
 * it as a child (`host/host-actions.ts` mints that span, `action.send`, for
 * an action that arrives without one). A prompt is the one action with a
 * name of its own: its trace starts here, the moment the operator submits,
 * as `prompt.send` (kind client), and it ends when the server answers the
 * `submit` action, accepted or refused.
 *
 * A prompt also opens `prompt.visible`, the number a person feels: it
 * starts at the same submit and ends when the first token of the answer is
 * on screen. It is a child of `prompt.send` in the same trace, and the
 * incoming event's stamped `trace_id` is what names it when the first token
 * arrives (`notePromptFirstToken`); a tab with one prompt in flight is also
 * matched by tab id, so an event the server has not stamped still closes it.
 *
 * Span lines go through `rendererLogger` (`span-writer.ts`). See
 * docs/observability/log-schema.md § Spans.
 */
import { startSpan, type Span } from '@ion/shared/trace-context'
import type { PromptSubmitResult } from '@ion/shared/prompt-submit-result'
import { rDebug } from '../rendererLogger'
import { host } from '../host/host-instance'
import { writeRendererSpan } from './span-writer'

export { writeRendererSpan } from './span-writer'

/** Which Studio client this renderer is: only the desktop host has an operating-system shell. */
export function rendererSurface(): 'studio-desktop' | 'studio-web' {
  return host.capabilities().includes('nativeShell') ? 'studio-desktop' : 'studio-web'
}

type SubmitOutcome = PromptSubmitResult | Promise<PromptSubmitResult> | void

/** The store's `submit`, narrowed to what a traced send passes. */
export type TracedSubmit = (tabId: string, text: string, opts: { traceparent: string }) => SubmitOutcome

interface PendingVisible {
  span: Span
  tabId: string
}

/** `prompt.visible` spans waiting for their first token, by tab. */
const pendingVisible = new Map<string, PendingVisible>()

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
  const attributes = {
    tab_id: tabId,
    surface: rendererSurface(),
    ...(conversationId ? { conversation_id: conversationId } : {}),
  }
  const span = startSpan('prompt.send', {
    writer: writeRendererSpan,
    kind: 'client',
    // The callee, so a trace backend names the dependency's target.
    attributes: { 'peer.service': 'ion-server', ...attributes },
  })
  openVisible(tabId, span, attributes)
  let outcome: SubmitOutcome
  try {
    outcome = submit(tabId, text, { traceparent: span.traceparent })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    span.end(undefined, message)
    closeVisible(tabId, undefined, message)
    throw err
  }
  if (outcome && typeof (outcome as Promise<PromptSubmitResult>).then === 'function') {
    void (outcome as Promise<PromptSubmitResult>).then(
      (result) => endWithResult(span, tabId, result),
      // The caller handles the rejection itself; this branch only closes the spans.
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        span.end(undefined, message)
        closeVisible(tabId, undefined, message)
      },
    )
  } else {
    endWithResult(span, tabId, outcome as PromptSubmitResult | void)
  }
  return outcome
}

function endWithResult(span: Span, tabId: string, result: PromptSubmitResult | void): void {
  if (!result || result.accepted) {
    span.end({ accepted: true })
    return
  }
  const error = `prompt refused: ${result.reason}`
  span.end({ accepted: false, reason: result.reason }, error)
  closeVisible(tabId, { reason: result.reason }, error)
}

function openVisible(tabId: string, parent: Span, attributes: Record<string, unknown>): void {
  const stale = pendingVisible.get(tabId)
  if (stale) {
    stale.span.end(undefined, 'superseded by a later prompt on the same tab')
    rDebug('action-trace', 'prompt.visible superseded before its first token', { tab_id: tabId, trace_id: stale.span.traceId })
  }
  const span = startSpan('prompt.visible', { writer: writeRendererSpan, kind: 'internal', parent, attributes })
  pendingVisible.set(tabId, { span, tabId })
}

function closeVisible(tabId: string, extra: Record<string, unknown> | undefined, error: string): void {
  const pending = pendingVisible.get(tabId)
  if (!pending) return
  pendingVisible.delete(tabId)
  pending.span.end(extra, error)
}

/**
 * The first token of a prompt's answer reached `tabId`. Finds the waiting
 * `prompt.visible` by the event's stamped `trace_id` when the server stamped
 * one, else by tab, and ends it once the frame that shows the token has
 * painted. Returns whether a span was waiting.
 */
export function notePromptFirstToken(tabId: string, eventTraceId?: string): boolean {
  let pending: PendingVisible | undefined
  if (eventTraceId) {
    for (const candidate of pendingVisible.values()) {
      if (candidate.span.traceId === eventTraceId) { pending = candidate; break }
    }
  }
  pending ??= pendingVisible.get(tabId)
  if (!pending) return false
  pendingVisible.delete(pending.tabId)
  const joined = eventTraceId !== undefined && eventTraceId === pending.span.traceId
  const finish = (): void => {
    pending.span.end({ joined_by: joined ? 'trace_id' : 'tab_id' })
  }
  // The store update that carries the token commits on the next frame; the
  // span ends when that frame has had its chance to paint.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish)
  else finish()
  return true
}

/** TEST ONLY. */
export function _resetActionTraceForTest(): void {
  pendingVisible.clear()
}
