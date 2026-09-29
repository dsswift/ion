/**
 * prompt-delivery -- where the outcome of a client-submitted prompt goes.
 *
 * A prompt a client submits is not admitted where it is received. It is handed
 * to the store, which re-enters the pipeline and only then reaches the engine,
 * and that last step is where it is accepted or rejected. The submitter is
 * remembered here under the prompt's request id so the outcome can be routed
 * back: to a paired device as a `desktop_prompt_result` event, or to the caller
 * of the `session.prompt` Studio action as the value it is awaiting.
 *
 * A prompt the pipeline finishes WITHOUT an engine admission (a slash command
 * an extension ran, a `!` shell line, a steer into a running turn) never
 * claims its entry. `releaseUnclaimedPromptDelivery` settles those, so an
 * awaiting caller is always answered.
 */
import { log as _log } from '../logger'
import { traceFields } from '../tracing/prompt-span'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('prompt-delivery', msg, fields)
}

export interface PromptOutcome {
  accepted: boolean
  /** Why the prompt was not accepted. Absent on acceptance. */
  reason?: string
}

export type PromptDelivery = {
  tabId: string
  resolve: (outcome: PromptOutcome) => void
  /**
   * The traceparent of the submitter's open `prompt.handle` span. The store's
   * submit, which claims this entry, sends it to the engine as the run's
   * parent instead of starting a span of its own.
   */
  traceparent?: string
}

const pendingRemotePrompts = new Map<string, PromptDelivery>()

/** Register the caller of an action as the submitter. Resolves with the outcome; never rejects. */
export function awaitPromptDelivery(requestId: string, tabId: string, traceparent?: string): Promise<PromptOutcome> {
  return new Promise((resolve) => { pendingRemotePrompts.set(requestId, { tabId, resolve, traceparent }) })
}

export function takeRemotePromptDelivery(requestId: string): PromptDelivery | undefined {
  const pending = pendingRemotePrompts.get(requestId)
  pendingRemotePrompts.delete(requestId)
  return pending
}

/** Route `outcome` to the submitter a `takeRemotePromptDelivery` returned. */
export function settlePromptDelivery(delivery: PromptDelivery, requestId: string, outcome: PromptOutcome): void {
  log('prompt outcome returned to the awaiting caller', {
    request_id: requestId, tab_id: delivery.tabId, accepted: outcome.accepted, reason: outcome.reason, ...traceFields(delivery.traceparent),
  })
  delivery.resolve(outcome)
}

/**
 * Settle an entry nothing claimed. Called once the pipeline has returned: a
 * prompt bound for the engine claims its entry synchronously inside the
 * store's submit, so one still here was handled some other way. Returns
 * whether there was one to settle.
 */
export function releaseUnclaimedPromptDelivery(requestId: string, outcome: PromptOutcome): boolean {
  const delivery = takeRemotePromptDelivery(requestId)
  if (!delivery) return false
  settlePromptDelivery(delivery, requestId, outcome)
  return true
}
