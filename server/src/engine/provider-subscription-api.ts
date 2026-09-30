/**
 * provider-subscription-api — the Provider Subscription commands, headless.
 *
 * The engine resolves a provider's key from its configured subscription
 * lookup endpoint with the signed-in identity. These wrap the three
 * `provider_subscription_*` commands. Every answer carries the engine's full
 * snapshot, error or not, so a client always holds the state a command left;
 * the key itself never reaches this process.
 *
 * The engine also emits the snapshot on every change (a sign-in resolving a
 * key, a lookup finishing after a settings page opened, a selection from
 * another client, a sign-out). `wireProviderSubscriptionEvents` republishes
 * it so an open surface learns about changes it did not make; a receiver
 * REPLACES its view with the payload.
 */
import type { EngineEvent, ProviderSubscriptionStatus } from '@ion/shared/types-engine-event'
import { engineBridge } from '../state'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('provider-subscription', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('provider-subscription', msg, fields)
}

export const PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL = 'ion:provider-subscription-changed'

export function wireProviderSubscriptionEvents(
  bridge: { on: (ev: 'event', cb: (key: string, event: EngineEvent) => void) => void },
  emit: (channel: string, payload: unknown) => void,
): void {
  bridge.on('event', (_key: string, event: EngineEvent) => {
    if (event.type !== 'engine_provider_subscription') return
    const subscription = event.providerSubscription
    log('subscription snapshot republished', {
      state: subscription.state,
      source: subscription.source ?? '',
      count: subscription.options?.length ?? 0,
    })
    emit(PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL, subscription)
  })
}

export interface ProviderSubscriptionResult {
  ok: boolean
  error?: string
  subscription: ProviderSubscriptionStatus
}

/** The snapshot a failed request leaves when the engine sent none. */
const UNKNOWN: ProviderSubscriptionStatus = { state: 'failed', error: 'subscription state unavailable' }

async function send(cmd: string, payload: Record<string, unknown> = {}): Promise<ProviderSubscriptionResult> {
  const result = await engineBridge.request<{ subscription?: ProviderSubscriptionStatus }>(cmd, payload)
  const subscription = result.data?.subscription ?? { ...UNKNOWN, error: result.error ?? UNKNOWN.error }
  if (result.ok) {
    log('subscription command answered', { cmd, state: subscription.state, source: subscription.source ?? '' })
  } else {
    warn('subscription command failed', { cmd, state: subscription.state, error: result.error ?? 'unknown' })
  }
  return { ok: result.ok, error: result.ok ? undefined : result.error, subscription }
}

export function getProviderSubscription(): Promise<ProviderSubscriptionResult> {
  return send('provider_subscription_status')
}

/** Apply one offered subscription and remember it. Payload `{ id }`. */
export async function selectProviderSubscription(payload: unknown): Promise<ProviderSubscriptionResult> {
  const id = (payload as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || id.trim() === '') {
    log('subscription select rejected: malformed payload')
    const current = await getProviderSubscription()
    return { ok: false, error: 'a subscription id is required', subscription: current.subscription }
  }
  return send('provider_subscription_select', { subscriptionId: id })
}

/** Run a fresh lookup now. */
export function refreshProviderSubscription(): Promise<ProviderSubscriptionResult> {
  return send('provider_subscription_refresh')
}
