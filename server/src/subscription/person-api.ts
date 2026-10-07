/**
 * The Provider Subscription commands for one signed-in person, answered by
 * this server's own lookup (`subscription/index.ts`) rather than the engine's.
 *
 * They return the same `ProviderSubscriptionResult` the engine-backed
 * commands do, so the web client's prompt and Settings control read both
 * unchanged. A person can only read or change their own subscription: the
 * subject comes from the connection, never from an argument.
 */
import type { ProviderSubscriptionResult } from '@ion/shared/provider-subscription'
import type { SubscriptionStates } from './subscription-state'
import { subscriptionStates } from './index'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('subscription-person-api', msg, fields)
}

/** True when this server runs the per-person lookup, so these commands answer instead of the engine's. */
export function personLookupEnabled(states: SubscriptionStates = subscriptionStates()): boolean {
  return states.enabled()
}

/**
 * The person's snapshot. Reading it also starts their lookup the first time,
 * which is what makes the first open of an instance with no key run it: the
 * web client reads this the moment it connects.
 */
export async function personSubscription(subject: string, states: SubscriptionStates = subscriptionStates()): Promise<ProviderSubscriptionResult> {
  const status = states.status(subject)
  if (status.state === 'awaiting_identity' || status.state === 'failed') {
    log('first read for this person; resolving', { subject, state: status.state })
    void states.ensure(subject)
  }
  return { ok: true, subscription: states.status(subject) }
}

export async function selectPersonSubscription(subject: string, payload: unknown, states: SubscriptionStates = subscriptionStates()): Promise<ProviderSubscriptionResult> {
  const id = (payload as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || id.trim() === '') {
    log('select rejected: malformed payload', { subject })
    return { ok: false, error: 'a subscription id is required', subscription: states.status(subject) }
  }
  const result = await states.select(subject, id)
  return { ok: result.ok, error: result.error, subscription: result.status }
}

export async function refreshPersonSubscription(subject: string, states: SubscriptionStates = subscriptionStates()): Promise<ProviderSubscriptionResult> {
  const subscription = await states.refresh(subject)
  return { ok: true, subscription }
}
