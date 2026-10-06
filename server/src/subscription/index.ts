/**
 * The process-wide per-person subscription lookup: the one `SubscriptionStates`
 * this server runs, and the credential source that hands a person's key to the
 * engine.
 *
 * Built lazily so a server with no `server.json.subscriptionLookup` pays
 * nothing, and so a test can substitute the pieces.
 */
import type { ProviderSubscriptionStatus } from '@ion/shared/types-engine-event'
import { currentServerConfig } from '../config/current'
import { broadcast } from '../broadcast'
import { lookupSubscriptions } from './lookup-client'
import { FileSubscriptionCache } from './subscription-cache'
import { sessionTokenProvider } from './session-token-provider'
import { SubscriptionStates } from './subscription-state'
import type { PrincipalCredentialSource, ResolvedPrincipalCredential } from '../credentials/principal-source'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('subscription', msg, fields)
}

/**
 * The studio event carrying one person's snapshot. The third broadcast
 * argument names whose it is and only routes the event (`protocol/events.ts`);
 * a client receives the snapshot alone.
 */
export const SUBSCRIPTION_CHANGED_CHANNEL = 'ion:provider-subscription-changed'

let shared: SubscriptionStates | null = null

export function subscriptionStates(): SubscriptionStates {
  if (!shared) {
    shared = new SubscriptionStates({
      config: () => currentServerConfig().subscriptionLookup,
      tokens: sessionTokenProvider(() => currentServerConfig().oidc, () => currentServerConfig().subscriptionLookup),
      lookup: lookupSubscriptions,
      cache: new FileSubscriptionCache(),
      onChange: (subject: string, status: ProviderSubscriptionStatus) => broadcast(SUBSCRIPTION_CHANGED_CHANNEL, status, subject),
      providerDisplayName: () => currentServerConfig().subscriptionLookup?.displayName || undefined,
    })
  }
  return shared
}

/** TEST ONLY. Replaces the process-wide instance. */
export function _setSubscriptionStatesForTest(states: SubscriptionStates | null): void {
  shared = states
}

/** How long the engine's own credential ask waits for a lookup still in flight; the engine gives up at 5 seconds. */
const ASK_WAIT_MS = 4000

/**
 * The `subscription` credential source: the key the lookup applied for this
 * person, ahead of every manually configured key. It answers only for the
 * lookup's own provider, and only from that person's own state.
 *
 * A person asked about before their lookup has run (a restart, then a send
 * before anyone reconnected) starts it here and waits briefly, so the first
 * message after a restart is not refused for a key that is seconds away.
 */
export function subscriptionSource(states: () => SubscriptionStates = subscriptionStates): PrincipalCredentialSource {
  return {
    name: 'subscription',
    resolve: async (scope): Promise<ResolvedPrincipalCredential | null> => {
      const s = states()
      if (!s.enabled() || scope.axis.kind !== 'provider' || scope.subject === '') return null
      const provider = scope.axis.provider
      if (provider.toLowerCase() !== s.provider()) return null
      let key = s.keyFor(scope.subject, provider)
      if (key === null) {
        const state = s.status(scope.subject).state
        if (state === 'awaiting_identity' || state === 'resolving') {
          log('credential asked before the lookup settled; waiting for it', { subject: scope.subject, state })
          await Promise.race([s.ensure(scope.subject), new Promise<void>((resolve) => setTimeout(resolve, ASK_WAIT_MS))])
          key = s.keyFor(scope.subject, provider)
        }
      }
      if (key === null) {
        log('no subscription key for this person', { subject: scope.subject, state: s.status(scope.subject).state })
        return null
      }
      return { source: 'subscription', value: { kind: 'provider', token: key, header: s.header() || undefined } }
    },
  }
}

